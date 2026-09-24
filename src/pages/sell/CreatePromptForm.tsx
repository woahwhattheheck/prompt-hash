import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Eye, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import {
  ListingQualityChecklist,
  buildChecklistItems,
} from "@/components/sell/ListingQualityChecklist";
import { CreatorOnboarding } from "@/components/sell/CreatorOnboarding";
import { PricingGuidance } from "@/components/sell/PricingGuidance";
import { TagInput } from "@/components/sell/TagInput";
import { featuredPromptTemplates } from "@/data/featuredPrompts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWallet } from "@/hooks/useWallet";
import { unlockPublicKey } from "@/lib/env";
import {
  encryptPromptPlaintext,
  wrapPromptKey,
} from "@/lib/crypto/promptCrypto";
import { isIpfsUploadConfigured, uploadCiphertextToIpfs } from "@/lib/ipfs";
import { browserStellarConfig } from "@/lib/stellar/browserConfig";
import { xlmToStroops } from "@/lib/stellar/format";
import { createPrompt } from "@/lib/stellar/promptHashClient";
import {
  LISTING_LIMITS,
  RevenueSplitFormInput,
  createPromptSchema,
} from "@/lib/validation/listing";
import { MarkdownContent } from "@/components/MarkdownContent";
import { SimilarityPublishFeedback } from "@/components/sell/SimilarityPublishFeedback";
import {
  checkPublishSimilarity,
  type PublishSimilarityResult,
} from "@/lib/prompts/similarityPublish";

const limits = {
  ...LISTING_LIMITS,
  encrypted: 4096,
  wrappedKey: 256,
};

const categories = Array.from(
  new Set(featuredPromptTemplates.map((prompt) => prompt.category)),
);

interface FormData {
  imageUrl: string;
  title: string;
  category: string;
  previewText: string;
  description: string;
  fullPrompt: string;
  priceXlm: string;
  tags: string[];
  coCreators: RevenueSplitFormInput[];
}

interface CreatePromptFormProps {
  onCreated?: () => void;
}

const DRAFT_STORAGE_PREFIX = "prompt-hash:create-draft:";

export function CreatePromptForm({ onCreated }: CreatePromptFormProps) {
  const navigate = useNavigate();
  const { address, signTransaction } = useWallet();
  const draftStorageKey = address ? `${DRAFT_STORAGE_PREFIX}${address}` : null;
  const draftLoadRef = useRef<string | null>(null);
  
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [similarityResult, setSimilarityResult] = useState<PublishSimilarityResult | null>(null);
  const [similarityChecking, setSimilarityChecking] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [showChecklist, setShowChecklist] = useState(true);
  const [draftRestored, setDraftRestored] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(true);
  const [isFirstListing] = useState(true);
  const [descriptionTab, setDescriptionTab] = useState<"write" | "preview">("write");

  const [draftCheckCompleted, setDraftCheckCompleted] = useState(false);
  const [hasDraftToRestore, setHasDraftToRestore] = useState(false);
  const [draftData, setDraftData] = useState<any>(null);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<any>({
    resolver: zodResolver(createPromptSchema),
    defaultValues: {
      imageUrl: "",
      title: "",
      category: "",
      previewText: "",
      description: "",
      fullPrompt: "",
      priceXlm: "2",
      coCreators: [],
    },
    mode: "onChange",
  });

  const watchAllFields = watch();

  useEffect(() => {
    setReviewAcknowledged(false);
    setSimilarityResult(null);
  }, [watchAllFields.title, watchAllFields.fullPrompt]);


  const isConfigured = useMemo(
    () => Boolean(address && browserStellarConfig.promptHashContractId && unlockPublicKey),
    [address]
  );

  const offChainStorage = useMemo(() => isIpfsUploadConfigured(), []);

  const checklistItems = useMemo(
    () =>
      buildChecklistItems(
        {
          title: watchAllFields.title || "",
          description: watchAllFields.description || "",
          fullPrompt: watchAllFields.fullPrompt || "",
          priceXlm: String(watchAllFields.priceXlm || "0"), // Pass as a string text token!
          imageUrl: watchAllFields.imageUrl || "",
          category: watchAllFields.category || "",
          previewText: watchAllFields.previewText || "",
          coCreators: watchAllFields.coCreators || [],
        },
        { offChainStorage },
      ),
    [watchAllFields, offChainStorage],
  );

  const checklistHasFailures = checklistItems.some((i) => i.status === "fail");
  
  const coCreatorsList = watchAllFields.coCreators || [];
  const totalRevenueSharePercent = useMemo(
    () =>
      coCreatorsList.reduce(
        (sum: number, coCreator: any) => sum + (Number(coCreator?.sharePercent?.trim()) || 0),
        0,
      ),
    [coCreatorsList],
  );

  const isFormEmpty = (data: any) => {
    return (
      !data.imageUrl &&
      !data.title &&
      !data.category &&
      !data.previewText &&
      !data.description &&
      (!data.priceXlm || data.priceXlm === "2") &&
      (!data.coCreators || data.coCreators.length === 0)
    );
  };

  // Load draft check on mount / storage key change
  useEffect(() => {
    setDraftCheckCompleted(false);
    setHasDraftToRestore(false);
    setDraftData(null);
    setDraftRestored(false);
    setLastSavedAt(null);

    if (!draftStorageKey) {
      return;
    }

    const rawDraft = typeof window !== "undefined" && window.localStorage?.getItem
      ? window.localStorage.getItem(draftStorageKey)
      : null;

    if (rawDraft) {
      try {
        const parsed = JSON.parse(rawDraft);
        if (parsed && parsed.formData) {
          setDraftData(parsed);
          setHasDraftToRestore(true);
        } else {
          setDraftCheckCompleted(true);
        }
      } catch {
        if (typeof window !== "undefined" && window.localStorage?.removeItem) {
          window.localStorage.removeItem(draftStorageKey);
        }
        setDraftCheckCompleted(true);
      }
    } else {
      setDraftCheckCompleted(true);
    }
  }, [draftStorageKey]);

  // Autosave effect with debounce
  useEffect(() => {
    if (!draftStorageKey || !draftCheckCompleted || hasDraftToRestore) {
      return;
    }

    const handler = setTimeout(() => {
      const dataToSave = {
        imageUrl: watchAllFields.imageUrl,
        title: watchAllFields.title,
        category: watchAllFields.category,
        previewText: watchAllFields.previewText,
        description: watchAllFields.description,
        priceXlm: watchAllFields.priceXlm,
        coCreators: watchAllFields.coCreators,
      };

      if (isFormEmpty(dataToSave)) {
        if (typeof window !== "undefined" && window.localStorage?.removeItem) {
          window.localStorage.removeItem(draftStorageKey);
        }
        setLastSavedAt(null);
      } else {
        const savedAt = new Date().toISOString();
        if (typeof window !== "undefined" && window.localStorage?.setItem) {
          window.localStorage.setItem(
            draftStorageKey,
            JSON.stringify({
              formData: dataToSave,
              savedAt,
            }),
          );
        }
        setLastSavedAt(savedAt);
        setDraftRestored(false);
      }
    }, 1000);

    return () => clearTimeout(handler);
  }, [
    draftStorageKey,
    draftCheckCompleted,
    hasDraftToRestore,
    watchAllFields.imageUrl,
    watchAllFields.title,
    watchAllFields.category,
    watchAllFields.previewText,
    watchAllFields.description,
    watchAllFields.priceXlm,
    JSON.stringify(watchAllFields.coCreators),
  ]);

  const handleRestoreDraft = () => {
    if (!draftData || !draftData.formData) return;

    const fieldsToRestore = [
      "imageUrl",
      "title",
      "category",
      "previewText",
      "description",
      "priceXlm",
      "coCreators",
    ];

    fieldsToRestore.forEach((key) => {
      if (draftData.formData[key] !== undefined) {
        setValue(key, draftData.formData[key]);
      }
    });

    setDraftRestored(true);
    setLastSavedAt(draftData.savedAt ?? null);
    setHasDraftToRestore(false);
    setDraftCheckCompleted(true);
  };

  const handleDiscardDraft = () => {
    if (draftStorageKey && typeof window !== "undefined" && window.localStorage?.removeItem) {
      window.localStorage.removeItem(draftStorageKey);
    }

    if (draftRestored || hasDraftToRestore) {
      setValue("imageUrl", "");
      setValue("title", "");
      setValue("category", "");
      setValue("previewText", "");
      setValue("description", "");
      setValue("priceXlm", "2");
      setValue("coCreators", []);
      setValue("fullPrompt", "");
    }

    setHasDraftToRestore(false);
    setDraftRestored(false);
    setLastSavedAt(null);
    setDraftData(null);
    setDraftCheckCompleted(true);
  };

  const onSubmit = async (data: FormData) => {
    setSubmitError(null);
    setSuccessMessage(null);

    if (!address || !signTransaction) {
      setSubmitError("Connect your wallet before creating a listing.");
      return;
    }

    if (!browserStellarConfig.promptHashContractId || !unlockPublicKey) {
      setSubmitError("Contract ID and unlock public key must be configured before listing.");
      return;
    }

    try {
      setSimilarityChecking(true);
      const gate = await checkPublishSimilarity({
        title: data.title,
        content: data.fullPrompt,
      });
      setSimilarityResult(gate);
      setSimilarityChecking(false);

      if (gate.decision === "block") {
        setSubmitError(
          "Publication blocked: this draft is too similar to an existing listing. Revise the prompt or request a maintainer override via appeal.",
        );
        return;
      }

      if (gate.decision === "review" && !reviewAcknowledged) {
        setSubmitError(
          "Elevated similarity — confirm you want to submit for maintainer review, then click Create again.",
        );
        setReviewAcknowledged(true);
        return;
      }

      const encrypted = await encryptPromptPlaintext(data.fullPrompt);
      const wrappedKey = await wrapPromptKey(encrypted.keyBytes, unlockPublicKey);
      const splits = (data.coCreators ?? [])
        .filter((coCreator) => coCreator.address.trim() && coCreator.sharePercent.trim())
        .map((coCreator) => ({
          recipient: coCreator.address.trim(),
          bps: Math.round(Number(coCreator.sharePercent) * 100),
        }));

      const result = await createPrompt(
        browserStellarConfig,
        { signTransaction },
        address,
        {
          imageUrl: data.imageUrl,
          title: data.title,
          category: data.category,
          previewText: data.previewText,
          encryptedPrompt: encrypted.encryptedPrompt,
          encryptionIv: encrypted.encryptionIv,
          wrappedKey,
          contentHash: encrypted.contentHash,
          priceStroops: xlmToStroops(data.priceXlm),
          splits,
        },
      );

      if (draftStorageKey && typeof window !== "undefined" && window.localStorage?.removeItem) {
        window.localStorage.removeItem(draftStorageKey);
      }

      setSuccessMessage(`Prompt #${result.promptId.toString()} created successfully.`);
      onCreated?.();
    } catch (error) {
      setSimilarityChecking(false);
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Failed to create prompt listing.",
      );
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div>
        {showOnboarding && (
          <CreatorOnboarding
            isFirstListing={isFirstListing}
            {...({ onDismiss: () => setShowOnboarding(false) } as any)}
          />
        )}

        {!isConfigured && (
          <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 mb-4">
            Connect your wallet and configure `PUBLIC_PROMPT_HASH_CONTRACT_ID` plus `PUBLIC_UNLOCK_PUBLIC_KEY` before listing prompts.
          </div>
        )}

        {hasDraftToRestore && draftData && isConfigured && (
          <div className="flex flex-col gap-3 rounded-2xl border border-cyan-400/20 bg-cyan-500/10 p-4 text-xs text-cyan-100 mb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" />
              <span>
                We found a saved draft from{" "}
                {draftData.savedAt ? new Date(draftData.savedAt).toLocaleString() : "previous session"}.
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-7 bg-cyan-400 text-slate-950 hover:bg-cyan-300 px-3 py-1"
                onClick={handleRestoreDraft}
              >
                Restore Draft
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 border-cyan-400/30 text-cyan-200 hover:bg-cyan-400/10 hover:text-cyan-50 px-3 py-1 bg-transparent"
                onClick={handleDiscardDraft}
              >
                Discard
              </Button>
            </div>
          </div>
        )}

        {!hasDraftToRestore && (draftRestored || lastSavedAt) && isConfigured && (
          <div className="flex items-center gap-2 rounded-2xl border border-cyan-400/20 bg-cyan-500/10 px-4 py-2.5 text-xs text-cyan-100 mb-4">
            {draftRestored ? (
              <>
                <span className="h-2 w-2 rounded-full bg-cyan-400" />
                Draft restored from {lastSavedAt ? new Date(lastSavedAt).toLocaleString() : "previous session"}
              </>
            ) : (
              <>
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                Draft saved {lastSavedAt ? new Date(lastSavedAt).toLocaleString() : ""}
              </>
            )}
            <button
              type="button"
              className="ml-auto text-xs text-cyan-200 underline underline-offset-2 hover:text-cyan-50"
              onClick={handleDiscardDraft}
            >
              Discard
            </button>
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="imageUrl" className="text-sm font-medium text-slate-100">
              Image URL <span aria-hidden="true" className="text-red-400">*</span>
            </label>
            <Input
              id="imageUrl"
              type="url"
              placeholder="https://example.com/prompt-cover.png"
              {...register("imageUrl")}
            />
            {errors.imageUrl && <p className="text-sm text-red-400">{errors.imageUrl.message?.toString()}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="title" className="text-sm font-medium text-slate-100">
              Title <span aria-hidden="true" className="text-red-400">*</span>
            </label>
            <Input
              id="title"
              placeholder="Board-ready launch plan"
              className={errors.title ? "border-red-500" : ""}
              {...register("title")}
            />
            <p className="text-xs text-slate-400">/{limits.title}</p>
            {errors.title && (
              <p className="flex items-center gap-1 text-sm text-red-400">
                <AlertCircle className="h-3.5 w-3.5" />
                {errors.title.message?.toString()}
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-[1fr_220px] mt-4">
          <div className="space-y-2">
            <label htmlFor="previewText" className="text-sm font-medium text-slate-100">
              Preview text <span aria-hidden="true" className="text-red-400">*</span>
            </label>
            <Textarea
              id="previewText"
              placeholder="This public preview is visible on browse cards and modals."
              rows={4}
              className={errors.previewText ? "border-red-500" : ""}
              {...register("previewText")}
            />
            <p className="text-xs text-slate-400">/{limits.preview}</p>
            {errors.previewText && (
              <p className="flex items-center gap-1 text-sm text-red-400">
                <AlertCircle className="h-3.5 w-3.5" />
                {errors.previewText.message?.toString()}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="category" className="text-sm font-medium text-slate-100">
              Category <span aria-hidden="true" className="text-red-400">*</span>
            </label>
            <Controller
              name="category"
              control={control}
              render={({ field }) => (
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger id="category" aria-label="Prompt category">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />

            <label htmlFor="priceXlm" className="pt-3 text-sm font-medium text-slate-100 block">
              Price in XLM <span aria-hidden="true" className="text-red-400">*</span>
            </label>
            <Input
              id="priceXlm"
              type="number"
              inputMode="decimal"
              step="any"
              placeholder="2.5"
              className={errors.priceXlm ? "border-red-500" : ""}
              {...register("priceXlm")}
            />
            {errors.priceXlm && (
              <p className="flex items-center gap-1 text-sm text-red-400 mt-1">
                <AlertCircle className="h-3.5 w-3.5" />
                {errors.priceXlm.message?.toString()}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2 mt-4">
          <div className="flex items-center justify-between">
            <label htmlFor="description" className="text-sm font-medium text-slate-100">
              Description <span className="text-slate-500 font-normal">(Markdown supported)</span>
            </label>
            <div className="flex gap-1 rounded-lg border border-white/10 p-0.5 bg-slate-900/60">
              <button
                type="button"
                onClick={() => setDescriptionTab("write")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  descriptionTab === "write" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                <Pencil className="h-3 w-3" /> Write
              </button>
              <button
                type="button"
                onClick={() => setDescriptionTab("preview")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  descriptionTab === "preview" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                <Eye className="h-3 w-3" /> Preview
              </button>
            </div>
          </div>
          {descriptionTab === "write" ? (
            <Textarea
              id="description"
              placeholder="Describe your prompt in detail. **Bold**, *italics*, `code`, and lists all work."
              rows={6}
              {...register("description")}
            />
          ) : (
            <div className="min-h-[144px] rounded-md border border-white/10 bg-slate-900/40 p-3">
              {watchAllFields.description ? (
                <MarkdownContent>{watchAllFields.description}</MarkdownContent>
              ) : (
                <p className="text-sm text-slate-500 italic">Nothing to preview yet — write some Markdown first.</p>
              )}
            </div>
          )}
          <p className="text-xs text-slate-400">
            {(watchAllFields.description || "").length} / 4000 characters
          </p>
          {errors.description && <p className="text-sm text-red-400">{errors.description.message?.toString()}</p>}
        </div>

        <PricingGuidance currentPriceXlm={watchAllFields.priceXlm} />

        <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/40 p-4 mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-slate-100">Co-creators and revenue splits</h3>
              <p className="text-xs text-slate-400">Share a portion of each sale with collaborators.</p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={coCreatorsList.length >= LISTING_LIMITS.maxCoCreators}
              onClick={() => setValue("coCreators", [...coCreatorsList, { address: "", sharePercent: "" }])}
            >
              <Plus className="h-4 w-4" /> Add co-creator
            </Button>
          </div>

          {coCreatorsList.length > 0 ? (
            <div className="space-y-3">
              {coCreatorsList.map((coCreator: any, index: number) => (
                <div
                  key={index}
                  className="grid gap-3 rounded-xl border border-slate-800/80 bg-slate-900/50 p-3 md:grid-cols-[minmax(0,1fr)_140px_auto]"
                >
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-300">Stellar address</label>
                    <Input
                      placeholder="G..."
                      {...register(`coCreators.${index}.address`)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-slate-300">Share %</label>
                    <Input
                      inputMode="decimal"
                      placeholder="15"
                      {...register(`coCreators.${index}.sharePercent`)}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      className="px-3 text-slate-300 hover:text-white"
                      onClick={() => setValue("coCreators", coCreatorsList.filter((_: any, i: number) => i !== index))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400">Add collaborators here when a prompt has multiple creators.</p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <span>Total shared: {totalRevenueSharePercent.toFixed(2)}%</span>
            <span>Primary creator keeps: {Math.max(0, 100 - totalRevenueSharePercent).toFixed(2)}%</span>
          </div>
        </div>

        <div className="space-y-2 mt-4">
          <label htmlFor="fullPrompt" className="text-sm font-medium text-slate-100">
            Full prompt <span aria-hidden="true" className="text-red-400">*</span>
          </label>
          <Textarea
            id="fullPrompt"
            rows={12}
            placeholder="This plaintext is encrypted in the browser, then only encrypted fields are sent on-chain."
            className={errors.fullPrompt ? "border-red-500" : ""}
            {...register("fullPrompt")}
          />
          {errors.fullPrompt && (
            <p className="flex items-center gap-1 text-sm text-red-400">
              <AlertCircle className="h-3.5 w-3.5" />
              {errors.fullPrompt.message?.toString()}
            </p>
          )}
        </div>

        {showChecklist && <ListingQualityChecklist items={checklistItems} />}

        <SimilarityPublishFeedback
          result={similarityResult}
          checking={similarityChecking}
        />

        <Button
          type="submit"
          className="w-full bg-emerald-400 text-slate-950 hover:bg-emerald-300 mt-4"
          disabled={
            isSubmitting ||
            similarityChecking ||
            (showChecklist && checklistHasFailures) ||
            similarityResult?.decision === "block"
          }
        >
          {isSubmitting || similarityChecking ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {similarityChecking ? "Checking similarity..." : "Encrypting and submitting..."}
            </>
          ) : similarityResult?.decision === "review" && reviewAcknowledged ? (
            "Submit for review"
          ) : (
            "Create prompt listing"
          )}
        </Button>

        {submitError && (
          <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200 mt-2">
            {submitError}
          </div>
        )}

        {successMessage && (
          <div className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100 mt-2">
            {successMessage}
          </div>
        )}
      </div>
    </form>
  );
}
