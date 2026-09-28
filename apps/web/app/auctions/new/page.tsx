'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApiError } from '@/lib/apiClient';
import { createAuctionRequest, publishAuctionRequest, startAuctionRequest } from '@/lib/auctions';
import { AUCTION_CATEGORIES, AUCTION_CONDITIONS } from '@/lib/types/auction';
import { computeEndTime, DURATION_LABELS } from '@/lib/duration';
import { formatCategory } from '@/lib/format';
import { isAllowedImageFile, requestPresignedUpload, uploadToPresignedUrl } from '@/lib/uploads';
import { createAuctionFormSchema, type CreateAuctionFormValues } from '@/lib/validation/auction';
import { useAuthStore } from '@/store/authStore';

const MAX_IMAGES = 10;

// Chains three backend calls (create -> publish -> start) into one submit.
// The backend deliberately keeps these as separate lifecycle actions
// (ADR-0009/0010) so a real seller dashboard can offer them independently
// later — but a seller using this simple form almost certainly wants their
// auction live immediately, not sitting in DRAFT/PUBLISHED limbo waiting
// for more UI that doesn't exist yet (that's WEB-003 territory).
export default function NewAuctionPage() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);
  const accessToken = useAuthStore((state) => state.accessToken);
  const [stageError, setStageError] = useState<{ message: string; draftAuctionId?: string } | null>(null);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace('/login');
    }
  }, [status, router]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateAuctionFormValues>({
    resolver: zodResolver(createAuctionFormSchema),
    defaultValues: { durationHours: '24' },
  });

  if (status !== 'authenticated' || !accessToken) {
    return (
      <main className="flex-1 p-6">
        <p className="text-gray-500">Loading…</p>
      </main>
    );
  }

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
    const startingPriceCents = Math.round(Number(values.startingPrice) * 100);
    const reservePriceCents =
      values.reservePrice && values.reservePrice !== '' ? Math.round(Number(values.reservePrice) * 100) : undefined;

    let auctionId: string;
    try {
      const { auction } = await createAuctionRequest(accessToken, {
        title: values.title,
        description: values.description,
        category: values.category,
        condition: values.condition,
        startingPriceCents,
        ...(reservePriceCents !== undefined ? { reservePriceCents } : {}),
        ...(imageUrls.length > 0 ? { images: imageUrls } : {}),
      });
      auctionId = auction.id;
    } catch (err) {
      setStageError({ message: err instanceof ApiError ? err.message : 'Failed to create the auction.' });
      return;
    }

    const endTime = computeEndTime(values.durationHours);

    try {
      await publishAuctionRequest(accessToken, auctionId, endTime);
      await startAuctionRequest(accessToken, auctionId);
    } catch (err) {
      // The auction row now genuinely exists (as DRAFT or PUBLISHED) even
      // though this step failed — there's no seller dashboard yet to
      // finish the job from, so the honest thing is to say so and link to
      // it, not to pretend nothing happened.
      setStageError({
        message:
          err instanceof ApiError
            ? `Auction created, but could not be published: ${err.message}`
            : 'Auction created, but could not be published automatically.',
        draftAuctionId: auctionId,
      });
      return;
    }

    router.push(`/auctions/${auctionId}`);
  };

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Create an auction</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-gray-700">
            Title
          </label>
          <input
            id="title"
            type="text"
            {...register('title')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          {errors.title && <p className="mt-1 text-sm text-red-600">{errors.title.message}</p>}
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            id="description"
            rows={4}
            {...register('description')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          />
          {errors.description && <p className="mt-1 text-sm text-red-600">{errors.description.message}</p>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="category" className="block text-sm font-medium text-gray-700">
              Category
            </label>
            <select
              id="category"
              {...register('category')}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            >
              {AUCTION_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {formatCategory(category)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="condition" className="block text-sm font-medium text-gray-700">
              Condition
            </label>
            <select
              id="condition"
              {...register('condition')}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            >
              {AUCTION_CONDITIONS.map((condition) => (
                <option key={condition} value={condition}>
                  {formatCategory(condition)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="startingPrice" className="block text-sm font-medium text-gray-700">
              Starting price ($)
            </label>
            <input
              id="startingPrice"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              {...register('startingPrice')}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
            {errors.startingPrice && <p className="mt-1 text-sm text-red-600">{errors.startingPrice.message}</p>}
          </div>
          <div>
            <label htmlFor="reservePrice" className="block text-sm font-medium text-gray-700">
              Reserve price ($, optional)
            </label>
            <input
              id="reservePrice"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              {...register('reservePrice')}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />
            {errors.reservePrice && <p className="mt-1 text-sm text-red-600">{errors.reservePrice.message}</p>}
          </div>
        </div>

        <div>
          <label htmlFor="images" className="block text-sm font-medium text-gray-700">
            Photos (optional, up to {MAX_IMAGES})
          </label>
          <input
            id="images"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={uploading || imageUrls.length >= MAX_IMAGES}
            onChange={(event) => {
              void handleFilesSelected(event.target.files);
              // Reset so selecting the exact same file again (e.g. after
              // removing it) still fires a change event.
              event.target.value = '';
            }}
            className="mt-1 block w-full text-sm"
          />
          {uploading && <p className="mt-1 text-sm text-gray-500">Uploading…</p>}
          {uploadError && <p className="mt-1 text-sm text-red-600">{uploadError}</p>}
          {imageUrls.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {imageUrls.map((url) => (
                <div key={url} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element --
                      These come from our own object storage (dev: local
                      s3mock, prod: R2), whose domain isn't fixed yet — using
                      next/image here would require remotePatterns config for
                      a domain that doesn't exist until deployment. Revisit
                      once the production storage domain is known. */}
                  <img src={url} alt="" className="h-20 w-20 rounded border border-gray-200 object-cover" />
                  <button
                    type="button"
                    onClick={() => removeImage(url)}
                    aria-label="Remove photo"
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black text-xs text-white"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="durationHours" className="block text-sm font-medium text-gray-700">
            Duration
          </label>
          <select
            id="durationHours"
            {...register('durationHours')}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
          >
            {Object.entries(DURATION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {stageError && (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            <p>{stageError.message}</p>
            {stageError.draftAuctionId && (
              <p className="mt-1">
                <Link href={`/auctions/${stageError.draftAuctionId}`} className="underline">
                  View the auction
                </Link>
              </p>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting || uploading}
          className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {isSubmitting ? 'Creating…' : 'Create and publish'}
        </button>
      </form>
    </main>
  );
}
