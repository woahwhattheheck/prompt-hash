from pathlib import Path
import hashlib
import json
import os
import subprocess
import time
import traceback

ROOT = Path(os.environ['GITHUB_WORKSPACE'])
SUBJECT = ROOT / 'subject'
OUT = ROOT / 'evidence'
OUT.mkdir(exist_ok=True)
PIN = '7c45877bd7c849a8b94356c2d692845a7d654c91'
BRANCH = 'validation/quarry-ph277-csv-candidate-20261004'
receipt = {'baseline_sha': PIN, 'success': False, 'commands': []}

def run(label, args, check=True, cwd=SUBJECT, timeout=180):
    start = time.monotonic()
    with (OUT / (label + '.log')).open('w') as log:
        p = subprocess.run(args, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    receipt['commands'].append({'label': label, 'argv': args, 'exit_code': p.returncode, 'seconds': time.monotonic() - start})
    if check and p.returncode:
        raise RuntimeError(f'{label} exited {p.returncode}')
    return p.returncode, (OUT / (label + '.log')).read_text()

def replace_once(text, before, after):
    assert text.count(before) == 1, before
    return text.replace(before, after)

try:
    assert run('head', ['git', 'rev-parse', 'HEAD'])[1].strip() == PIN
    service_path = SUBJECT / 'server/src/services/payoutStatementService.ts'
    original = service_path.read_bytes()
    digest = hashlib.sha1(b'blob ' + str(len(original)).encode() + b'\0' + original).hexdigest()
    assert digest == '3d249b8648de4e52dc4512ceca8bed85bd445ee5', digest
    run('install', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=SUBJECT/'server')
    test_path = SUBJECT / 'server/src/tests/payoutStatement.test.ts'
    text = test_path.read_text()
    text = replace_once(text, 'default: { findOneAndUpdate: jest.fn() }',
                        'default: { findOneAndUpdate: jest.fn(), findOne: jest.fn() }')
    text += r'''

// Parse the emitted CSV independently of its escaping helper, including
// embedded separators, newlines and doubled quotes.
function readPayoutCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (!quoted && ch === ',') {
      row.push(value); value = "";
    } else if (!quoted && ch === '\n') {
      row.push(value); rows.push(row); row = []; value = "";
    } else value += ch;
  }
  row.push(value); rows.push(row);
  expect(quoted).toBe(false);
  return rows;
}

describe("CSV text cells", () => {
  const period = { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.999Z" };
  const build = (text: string) => reconcilePayoutStatement({
    statementId: "stmt_csv_fixture",
    sellerWallet: "GSELLER",
    period,
    previousBalanceCarryoverStroops: -100,
    purchases: [{ purchaseId: text, promptId: "p1", buyerWallet: "gbuyer", grossStroops: 10_000, purchasedAt: period.start }],
    refunds: [{ purchaseId: text, promptId: "p2", originalGrossStroops: 20_000, originalPurchasedAt: "2025-12-01T00:00:00.000Z", refundedAt: period.start }],
    payoutAttempts: [{ attemptId: text, amountStroops: 0, status: "failed", failureReason: text, txHash: text, attemptedAt: period.end }],
  });

  it.each(['=1+2', '+1+2', '-1+2', '@SUM(1)', '\t=1+2', '\r=1+2', '\n=1+2', '  =1+2', '＝1+2', '＋1+2', '－1+2', '＠SUM(1)', '=1+2",=3+4\nnext'])
    ("marks formula-like text as text in every section: %p", (text) => {
      const statement = build(text);
      const before = exportStatementToJson(statement);
      const rows = readPayoutCsv(exportStatementToCsv(statement));
      expect(rows.find((r) => r[0] === 'summary' && r[1] === 'failureReason')?.[2]).toBe("'" + text);
      expect(rows.find((r) => r[0] === 'sales' && r[1] !== 'purchaseId')?.[1]).toBe("'" + text);
      expect(rows.find((r) => r[0] === 'refunds' && r[1] !== 'purchaseId')?.[1]).toBe("'" + text);
      const attempt = rows.find((r) => r[0] === 'payoutAttempts' && r[1] !== 'attemptId');
      expect(attempt).toHaveLength(7);
      expect(attempt?.[1]).toBe("'" + text);
      expect(attempt?.[5]).toBe("'" + text);
      expect(attempt?.[6]).toBe("'" + text);
      expect(exportStatementToJson(statement)).toBe(before);
      expect(statement.signature).toBe(JSON.parse(before).signature);
    });

  it("preserves ordinary text, CSV quoting, blanks and numeric negative amounts", () => {
    for (const text of ['normal', 'ordinary =1+2', 'quoted,"value"\nnext']) {
      const statement = build(text);
      const rows = readPayoutCsv(exportStatementToCsv(statement));
      expect(rows.find((r) => r[0] === 'summary' && r[1] === 'failureReason')?.[2]).toBe(text);
      expect(rows.find((r) => r[0] === 'summary' && r[1] === 'netSettlementStroops')?.[2]).toBe('-9600');
      expect(exportStatementToCsv(statement)).toContain('summary,previousBalanceCarryoverStroops,-100');
    }
    const statement = build('normal');
    statement.failureReason = undefined;
    expect(exportStatementToCsv(statement)).toContain('summary,failureReason,\n');
  });

  it("serves protected CSV and unchanged signed JSON through the actual export route", async () => {
    const statement = build('=1+2');
    const findOne = PayoutStatementModel.findOne as jest.Mock;
    findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(statement) });
    const app = express();
    app.use('/api/payouts', payoutRouter);
    const csv = await request(app).get('/api/payouts/statements/GSELLER/stmt_csv_fixture/export?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(readPayoutCsv(csv.text).find((r) => r[0] === 'summary' && r[1] === 'failureReason')?.[2]).toBe("'=1+2");
    const json = await request(app).get('/api/payouts/statements/GSELLER/stmt_csv_fixture/export?format=json');
    expect(json.status).toBe(200);
    expect(json.body).toEqual(JSON.parse(exportStatementToJson(statement)));
    expect(json.body.failureReason).toBe('=1+2');
    expect(findOne).toHaveBeenLastCalledWith({ sellerWallet: 'gseller', statementId: 'stmt_csv_fixture' });
  });
});
'''
    test_path.write_text(text)
    baseline_args = ['npm', 'test', '--', '--runInBand', '--runTestsByPath', 'src/tests/payoutStatement.test.ts', '--testNamePattern=CSV text cells', '--json', '--outputFile=' + str(OUT/'baseline.json')]
    before, _ = run('baseline', baseline_args, check=False, cwd=SUBJECT/'server')
    assert before == 1, f'Expected reproduced failure, got {before}'
    result = json.loads((OUT/'baseline.json').read_text())
    assert result.get('numTotalTests', 0) > 0 and result.get('numFailedTests', 0) > 0, result
    source = original.decode()
    source = replace_once(source, r'''    if (/[",\n\r]/.test(raw)) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;''', r'''    // Quoting alone does not stop spreadsheet formula interpretation. Keep
    // amounts numeric; only potentially executable textual cells are marked.
    const prefix = typeof value === "string" &&
      (/^\s*[=+\-@＝＋－＠]/u.test(raw) || /^[\t\r\n]/.test(raw));
    const text = prefix ? `'${raw}` : raw;
    if (prefix || /[",\n\r]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;''')
    service_path.write_text(source)
    with (SUBJECT/'docs/payout-statements.md').open('a') as f:
        f.write('''\n\n## Formula-like text in CSV exports\n\nCSV export prefixes formula-like text with an apostrophe and quotes the complete\ncell, including formula markers after leading whitespace and their full-width\nvariants. Text beginning with tab, carriage return or line feed is also marked.\nEmbedded delimiters, quotes and newlines remain RFC-style escaped. Monetary\ncolumns remain numeric, including negative carryover and net settlement values.\nThis transformation applies only to the CSV presentation: stored statements,\nJSON exports and signed data are unchanged. Consumers requiring exact original\ntext should use the JSON export.\n\nThe initial-import text marker is not a universal spreadsheet security guarantee.\nSpreadsheet applications differ, and saving/reopening a CSV can remove escape\ncharacters. See OWASP's [CSV Injection guidance](https://owasp.org/www-community/attacks/CSV_Injection).\nThe maintained tests exercise actual exporter bytes and the Express download\nroute with the existing model mock; they do not execute Excel or LibreOffice.\n''')
    run('candidate', ['npm', 'test', '--', '--runInBand', '--runTestsByPath', 'src/tests/payoutStatement.test.ts', '--json', '--outputFile=' + str(OUT/'candidate.json')], cwd=SUBJECT/'server')
    run('versions', ['node', '-p', 'JSON.stringify({node:process.version,jest:require("jest/package.json").version,typescript:require("typescript/package.json").version})'], cwd=SUBJECT/'server')
    run('diff', ['git', 'diff'])
    run('name', ['git', 'config', 'user.name', 'woahwhattheheck'])
    run('email', ['git', 'config', 'user.email', '293286387+woahwhattheheck@users.noreply.github.com'])
    paths = ['server/src/services/payoutStatementService.ts', 'server/src/tests/payoutStatement.test.ts', 'docs/payout-statements.md']
    run('stage', ['git', 'add'] + paths)
    run('commit', ['git', 'commit', '-m', 'fix(payouts): mark formula-like CSV text without changing signed data [skip ci]'])
    receipt['candidate_sha'] = run('candidate-head', ['git', 'rev-parse', 'HEAD'])[1].strip()
    receipt['tree_sha'] = run('candidate-tree', ['git', 'rev-parse', 'HEAD^{tree}'])[1].strip()
    assert not run('clean', ['git', 'status', '--porcelain'])[1].strip()
    run('source', ['git', 'archive', '--format=tar.gz', '-o', str(OUT/'changed-source.tar.gz'), 'HEAD'] + paths)
    run('retain', ['git', 'push', 'origin', 'HEAD:refs/heads/' + BRANCH])
    receipt['candidate_branch'] = BRANCH
    receipt['success'] = True
except Exception:
    receipt['error'] = traceback.format_exc()
finally:
    (OUT/'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt, indent=2))
if not receipt['success']:
    raise SystemExit(1)
