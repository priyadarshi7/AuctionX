'use client';

import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { ApiError } from '@/lib/apiClient';
import { resendVerificationRequest } from '@/lib/auth';
import { createAuctionRequest } from '@/lib/auctions';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { AUCTION_CATEGORIES, AUCTION_CONDITIONS } from '@/lib/types/auction';
import { formatCategory } from '@/lib/format';
import { isAllowedImageFile, requestPresignedUpload, uploadToPresignedUrl } from '@/lib/uploads';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { createAuctionFormSchema, type CreateAuctionFormValues } from '@/lib/validation/auction';
import { Button } from '../../components/ui/Button';
import { SelectField, TextArea, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { PageHeader, PageLoading } from '../../components/ui/Page';

const MAX_IMAGES = 10;

// A placeholder, never shown to anyone and always overwritten before this
// auction can ever be published — see SetPriceAndPublishPanel
// (app/auctions/[id]/SetPriceAndPublishPanel.tsx). createAuctionSchema
// (services/api/src/modules/auctions/schema.ts) requires a positive
// startingPriceCents at the database level; this form deliberately doesn't
// ask for one (see the page-level comment below for why), so a nominal
// value satisfies that constraint without meaning anything.
const PLACEHOLDER_STARTING_PRICE_CENTS = 100;

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <section className="panel p-5 sm:p-6">
      <h2 className="mb-5 flex items-center gap-3 font-semibold tracking-tight">
        <span className="flex size-6 items-center justify-center rounded-md border border-border-strong font-mono text-xs text-muted-foreground">
          {step}
        </span>
        {title}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

// Collects everything EXCEPT price, then creates the DRAFT and hands off to
// the auction's own page — which shows the AI valuation (ADR-0032) and lets
// the seller set a real price and publish from there (SetPriceAndPublishPanel).
// Reported directly from real usage: showing the valuation only after an
// auction was already live defeated the point of having it — the number is
// meant to inform the price decision, not arrive after it.
export default function NewAuctionPage() {
  const router = useRouter();
  const auth = useRequireAuth();
  const [stageError, setStageError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateAuctionFormValues>({
    resolver: zodResolver(createAuctionFormSchema),
  });

  const watched = useWatch({ control });

  if (!auth.ready) {
    return <PageLoading />;
  }
  const { accessToken } = auth;

  // Uploads happen eagerly on file selection, not deferred to submit — the
  // presigned-POST pattern (lib/uploads.ts) is specifically designed for
  // this: each file goes straight to object storage the moment it's picked,
  // and the form just accumulates the resulting public URLs. Runs
  // sequentially, not Promise.all, so a slow/failing upload doesn't leave
  // partially-uploaded files racing each other for `imageUrls` state updates.
  const handleFilesSelected = async (fileList: FileList | null): Promise<void> => {
    if (!fileList || fileList.length === 0) return;
    setUploadError(null);

    const remainingSlots = MAX_IMAGES - imageUrls.length;
    const files = Array.from(fileList).slice(0, remainingSlots);
    if (fileList.length > remainingSlots) {
      setUploadError(`Only ${MAX_IMAGES} photos allowed — some files were skipped.`);
    }

    setUploading(true);
    try {
      for (const file of files) {
        if (!isAllowedImageFile(file)) {
          setUploadError(`${file.name}: unsupported file type (use JPEG, PNG, or WebP).`);
          continue;
        }
        const presigned = await requestPresignedUpload(accessToken, file.type);
        const url = await uploadToPresignedUrl(presigned, file);
        setImageUrls((prev) => [...prev, url]);
      }
    } catch (err) {
      setUploadError(err instanceof ApiError || err instanceof Error ? err.message : 'Image upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const removeImage = (url: string): void => {
    setImageUrls((prev) => prev.filter((existing) => existing !== url));
  };

  const onSubmit = async (values: CreateAuctionFormValues) => {
    setStageError(null);
    setNeedsVerification(false);
    setResendState('idle');
    try {
      const { auction } = await createAuctionRequest(accessToken, {
        title: values.title,
        description: values.description,
        category: values.category,
        condition: values.condition,
        startingPriceCents: PLACEHOLDER_STARTING_PRICE_CENTS,
        ...(imageUrls.length > 0 ? { images: imageUrls } : {}),
      });
      // Lands on the detail page as a DRAFT — AI valuation + real price
      // entry + publish all happen there (SetPriceAndPublishPanel).
      router.push(`/auctions/${auction.id}`);
    } catch (err) {
      setStageError(err instanceof ApiError ? err.message : 'Failed to create the auction.');
      setNeedsVerification(err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED');
    }
  };

  const handleResend = async () => {
    setResendState('sending');
    try {
      await resendVerificationRequest(accessToken);
      setResendState('sent');
    } catch {
      setResendState('idle');
    }
  };

  // Live preview, built from what's typed. Purely presentational; the
  // server validates the real values on submit.
  const previewCategory = watched.category ? CATEGORY_DISPLAY[watched.category] : null;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
      <PageHeader
        title="Sell an item"
        subtitle="Tell us about the item first — you'll see an AI valuation and set your price on the next step."
      />

      <div className="grid items-start gap-8 lg:grid-cols-[1fr_320px]">
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
          <Section step={1} title="What are you selling?">
            <TextField
              id="title"
              label="Title"
              placeholder="e.g. 1985 Air Jordan 1, size 10"
              error={errors.title?.message}
              {...register('title')}
            />
            <TextArea
              id="description"
              label="Description"
              rows={5}
              hint="Say what it is, its history, and any flaws. Honest listings get more bids."
              error={errors.description?.message}
              {...register('description')}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField id="category" label="Category" {...register('category')}>
                {AUCTION_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {formatCategory(category)}
                  </option>
                ))}
              </SelectField>
              <SelectField id="condition" label="Condition" {...register('condition')}>
                {AUCTION_CONDITIONS.map((condition) => (
                  <option key={condition} value={condition}>
                    {formatCategory(condition)}
                  </option>
                ))}
              </SelectField>
            </div>
          </Section>

          <Section step={2} title="Photos">
            <div>
              <label
                htmlFor="images"
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  void handleFilesSelected(event.dataTransfer.files);
                }}
                className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border border-dashed border-border-strong px-4 py-8 text-center transition-colors ${
                  dragging ? 'border-accent bg-accent-soft' : 'hover:bg-muted'
                } ${uploading || imageUrls.length >= MAX_IMAGES ? 'pointer-events-none opacity-60' : ''}`}
              >
                <IconUpload aria-hidden className="mb-1 size-5 text-muted-foreground" stroke={1.5} />
                <span className="text-sm font-medium">
                  {uploading ? 'Uploading…' : 'Drop photos here or click to browse'}
                </span>
                <span className="text-xs text-muted-foreground">
                  JPEG, PNG or WebP. Up to {MAX_IMAGES} photos ({imageUrls.length} added). The first is the cover.
                </span>
              </label>
              <input
                id="images"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                disabled={uploading || imageUrls.length >= MAX_IMAGES}
                className="sr-only"
                onChange={(event) => {
                  void handleFilesSelected(event.target.files);
                  // Reset so selecting the exact same file again (e.g. after
                  // removing it) still fires a change event.
                  event.target.value = '';
                }}
              />
              {uploadError && (
                <div className="mt-3">
                  <Notice tone="error">{uploadError}</Notice>
                </div>
              )}
            </div>

            {imageUrls.length > 0 && (
              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                {imageUrls.map((url, i) => (
                  <li key={url} className="relative aspect-square">
                    {/* eslint-disable-next-line @next/next/no-img-element --
                        These come from our own object storage (dev: local
                        s3mock, prod: R2), whose domain isn't fixed yet — using
                        next/image here would require remotePatterns config for
                        a domain that doesn't exist until deployment. */}
                    <img src={url} alt={`Photo ${i + 1}`} className="h-full w-full rounded-xl border border-border object-cover" />
                    {i === 0 && (
                      <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur">
                        Cover
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeImage(url)}
                      aria-label={`Remove photo ${i + 1}`}
                      className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-md bg-black/65 text-white backdrop-blur transition-colors hover:bg-red-600"
                    >
                      <IconX aria-hidden className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {stageError && (
            <Notice tone="error">
              <p>{stageError}</p>
              {needsVerification && (
                <div className="mt-2">
                  {resendState === 'sent' ? (
                    <span className="text-sm font-medium">Check your inbox — a new link is on its way.</span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={resendState === 'sending'}
                      onClick={handleResend}
                    >
                      {resendState === 'sending' ? 'Sending…' : 'Resend verification email'}
                    </Button>
                  )}
                </div>
              )}
            </Notice>
          )}

          <Button type="submit" disabled={isSubmitting || uploading} className="w-full sm:w-fit">
            {isSubmitting ? 'Saving…' : uploading ? 'Waiting for uploads…' : 'Continue to pricing'}
          </Button>
        </form>

        <aside aria-label="Listing preview" className="lg:sticky lg:top-24">
          <p className="eyebrow mb-2">Live preview</p>
          <div className="panel overflow-hidden">
            <div className="flex aspect-square items-center justify-center overflow-hidden bg-surface-muted">
              {imageUrls[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrls[0]} alt="" className="h-full w-full object-cover" />
              ) : (
                <IconPhoto aria-hidden className="size-8 text-muted-foreground/50" stroke={1.2} />
              )}
            </div>
            <div className="flex flex-col gap-1 border-t border-border p-3.5">
              {previewCategory && <p className="text-xs text-muted-foreground">{previewCategory.label}</p>}
              <p className="line-clamp-2 min-h-10 text-sm font-medium leading-snug">
                {watched.title || 'Your title appears here'}
              </p>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Next, you&apos;ll see an AI valuation for this item and set your own price before publishing.
          </p>
        </aside>
      </div>
    </main>
  );
}
