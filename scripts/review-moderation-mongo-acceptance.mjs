import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

const [beforeDirectory, afterDirectory, outputFile] = process.argv.slice(2);
if (!beforeDirectory || !afterDirectory || !outputFile) {
  throw new Error('Expected baseline directory, candidate directory, and result path');
}
const sourcePaths = [
  'src/lib/reviews/fileReviewRepository.ts',
  'src/lib/reviews/mongoReviewRepository.ts',
  'src/lib/reviews/pathLock.ts',
  'src/lib/reviews/reviewStore.ts',
  'src/lib/reviews/reviewTypes.ts',
  'server/src/models/Review.ts',
];
async function sourceManifest(directory) {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async (name) => {
    const content = await readFile(path.join(directory, name));
    return [name, {
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      git_blob: createHash('sha1').update('blob ' + content.length + '\0').update(content).digest('hex'),
    }];
  })));
}
const results = {
  schema: 'review-moderation-mongo-acceptance/v1',
  started_at: new Date().toISOString(),
  source_commits: { baseline: process.env.BASELINE_REF, candidate: process.env.CANDIDATE_REF },
  execution_commit: process.env.GITHUB_SHA,
  runtime: { node: process.version, mongoose: mongoose.version, mongodb_image: 'mongo:8.0' },
  source_files: {
    baseline: await sourceManifest(beforeDirectory),
    candidate: await sourceManifest(afterDirectory),
  },
  scope: 'Six Mongo scenarios on each source revision; real Mongoose model and MongoDB writes. File acceptance is separate.',
  ordering_method: 'Both repository calls reach the update boundary before either proceeds; a promise barrier orders the two real database updates. No database result, query, filter, update, or option is substituted.',
  phases: [],
};
const importSource = (directory, file) => import(pathToFileURL(path.join(directory, file)).href);
const { default: Review } = await importSource(afterDirectory, 'server/src/models/Review.ts');
const baselineFailures = ['hidden-new-report', 'hidden-duplicate-and-new-report', 'concurrent-hide-then-report'];
let activeCommands;

function orderedModel(first) {
  let arrivals = 0;
  let bothArrived;
  let firstFinished;
  const both = new Promise((resolve) => { bothArrived = resolve; });
  const firstDone = new Promise((resolve) => { firstFinished = resolve; });
  const completed = [];
  const model = new Proxy(Review, {
    get(target, property) {
      if (property !== 'findOneAndUpdate') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args) => {
        const update = args[1];
        const operation = !Array.isArray(update) && update.$set?.status === 'hidden' ? 'hide' : 'report';
        arrivals += 1;
        if (arrivals === 2) bothArrived();
        await both;
        if (operation !== first) await firstDone;
        try {
          const value = await target.findOneAndUpdate(...args);
          completed.push(operation);
          return value;
        } finally {
          if (operation === first) firstFinished();
        }
      };
    },
  });
  return { model, completed, arrivals: () => arrivals };
}

const scenarios = [
  { id: 'visible-report-literal', status: 'flagged', publicCount: 1, reportCount: 1,
    async act(repo, review) {
      await repo.reportReview(review.id, '179', 'GREPORTER', '  $status  ');
      return {};
    } },
  { id: 'hidden-new-report', status: 'hidden', publicCount: 0, reportCount: 1,
    async act(repo, review) {
      await repo.moderateReview(review.id, '179', 'hide');
      await repo.reportReview(review.id, '179', 'GREPORTER', '  $status  ');
      return {};
    } },
  { id: 'hidden-duplicate-and-new-report', status: 'hidden', publicCount: 0, reportCount: 2,
    async act(repo, review) {
      await repo.reportReview(review.id, '179', 'GEXISTING', 'Prior report');
      await repo.moderateReview(review.id, '179', 'hide');
      const outcomes = await Promise.allSettled([
        repo.reportReview(review.id, '179', '  gexisting  ', 'Duplicate report'),
        repo.reportReview(review.id, '179', 'GREPORTER', '  $status  '),
      ]);
      return { concurrent_outcomes: outcomes.map((outcome) => outcome.status === 'fulfilled' ? 'fulfilled' : outcome.reason.name) };
    } },
  ...['hide', 'report'].map((first) => ({
    id: first === 'hide' ? 'concurrent-hide-then-report' : 'concurrent-report-then-hide',
    status: 'hidden', publicCount: 0, reportCount: 1,
    async act(_repo, review, makeRepository) {
      const ordered = orderedModel(first);
      const concurrent = makeRepository(ordered.model);
      const outcomes = await Promise.allSettled([
        concurrent.moderateReview(review.id, '179', 'hide'),
        concurrent.reportReview(review.id, '179', 'GREPORTER', '  $status  '),
      ]);
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      if (rejected.length) throw rejected[0].reason;
      return { concurrent_call_arrivals: ordered.arrivals(), completed_writes: ordered.completed, expected_write_order: [first, first === 'hide' ? 'report' : 'hide'] };
    },
  })),
  { id: 'explicit-unhide-control', status: 'visible', publicCount: 1, reportCount: 1,
    async act(repo, review) {
      await repo.moderateReview(review.id, '179', 'hide');
      await repo.reportReview(review.id, '179', 'GREPORTER', '  $status  ');
      await repo.moderateReview(review.id, '179', 'unhide');
      return {};
    } },
];

try {
  await mongoose.connect('mongodb://127.0.0.1:27017/review_moderation_acceptance', {
    serverSelectionTimeoutMS: 10000, monitorCommands: true,
  });
  results.runtime.mongodb = (await mongoose.connection.db.admin().serverInfo()).version;
  await Review.init();
  mongoose.connection.getClient().on('commandStarted', (event) => {
    if (!activeCommands || event.commandName !== 'findAndModify') return;
    activeCommands.find_and_modify += 1;
    if (Array.isArray(event.command.update)) activeCommands.pipeline_updates += 1;
  });
  for (const [label, directory] of [['baseline', beforeDirectory], ['candidate', afterDirectory]]) {
    const { createMongoReviewRepository } = await importSource(directory, 'src/lib/reviews/mongoReviewRepository.ts');
    const store = await importSource(directory, 'src/lib/reviews/reviewStore.ts');
    const phase = { source: label, scenarios: [] };
    results.phases.push(phase);
    for (const scenario of scenarios) {
      await Review.deleteMany({});
      const repo = createMongoReviewRepository(Review);
      store.configureReviewRepository(repo);
      const record = { id: scenario.id, expected: { status: scenario.status, public_count: scenario.publicCount, report_count: scenario.reportCount } };
      phase.scenarios.push(record);
      activeCommands = { find_and_modify: 0, pipeline_updates: 0 };
      try {
        const review = await repo.addReview('179', 'GREVIEWBUYER', 5, 'Review moderation acceptance fixture');
        const details = await scenario.act(repo, review, createMongoReviewRepository);
        const actual = await repo.getById(review.id, '179');
        const stored = await Review.collection.findOne({ reviewId: review.id, promptId: '179' });
        const publicReviews = await store.getPublicReviews('179');
        record.observed = {
          status: actual.status, public_count: publicReviews.length, report_count: actual.reportCount,
          reports: actual.reports.map(({ reporterAddress, reason }) => ({ reporterAddress, reason })),
          stored_report_count: stored.reports.length,
          stored_report_dates_are_dates: stored.reports.every((report) => report.createdAt instanceof Date),
          stored_reports_have_no_subdocument_ids: stored.reports.every((report) => !Object.hasOwn(report, '_id')),
          ...details,
        };
        record.checks = {
          expected_status: actual.status === scenario.status,
          expected_public_visibility: publicReviews.length === scenario.publicCount,
          exact_report_count: actual.reportCount === scenario.reportCount && actual.reports.length === scenario.reportCount && stored.reports.length === scenario.reportCount,
          literal_reason_preserved: actual.reports.some((report) => report.reason === '$status' && report.reporterAddress === 'greporter'),
          stored_report_shape_preserved: record.observed.stored_report_dates_are_dates && record.observed.stored_reports_have_no_subdocument_ids,
        };
        if (details.concurrent_outcomes) record.checks.duplicate_only_rejected = JSON.stringify(details.concurrent_outcomes) === JSON.stringify(['DuplicateReportError', 'fulfilled']);
        if (details.completed_writes) record.checks.both_concurrent_calls_and_order = details.concurrent_call_arrivals === 2 && JSON.stringify(details.completed_writes) === JSON.stringify(details.expected_write_order);
        record.passed = Object.values(record.checks).every(Boolean);
      } catch (error) {
        record.passed = false;
        record.error = { name: error.name, message: error.message, stack: error.stack };
      } finally {
        record.database_commands = activeCommands;
        activeCommands = null;
        store.configureReviewRepository(null);
      }
    }
    phase.passed = phase.scenarios.filter((record) => record.passed).length;
    phase.failed = phase.scenarios.length - phase.passed;
  }
  const before = results.phases[0];
  const after = results.phases[1];
  const actualBaselineFailures = before.scenarios.filter((record) => !record.passed).map((record) => record.id);
  results.expected_baseline_failures = baselineFailures;
  results.baseline_failure_set_matches = JSON.stringify(actualBaselineFailures) === JSON.stringify(baselineFailures);
  results.candidate_all_passed = after.failed === 0;
  results.accepted = results.baseline_failure_set_matches && results.candidate_all_passed;
  await Review.deleteMany({});
} catch (error) {
  results.accepted = false;
  results.execution_error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  await mongoose.disconnect();
  results.finished_at = new Date().toISOString();
  await writeFile(outputFile, JSON.stringify(results, null, 2) + '\n');
}
console.log(JSON.stringify({ runtime: results.runtime, source_commits: results.source_commits, phases: results.phases.map(({ source, passed, failed }) => ({ source, passed, failed })), accepted: results.accepted, execution_error: results.execution_error ?? null }, null, 2));
if (!results.accepted) process.exitCode = 1;
