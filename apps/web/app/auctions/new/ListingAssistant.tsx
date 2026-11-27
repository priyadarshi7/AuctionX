'use client';

import { IconArrowBackUp, IconCamera, IconCheck, IconPlus, IconSparkles } from '@tabler/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { getAiStatusRequest, suggestListingRequest, type ListingDraft, type ListingSuggestion } from '@/lib/ai';
import { ApiError } from '@/lib/apiClient';
import { formatCategory } from '@/lib/format';
import type { CreateAuctionFormValues } from '@/lib/validation/auction';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';

type Field = keyof CreateAuctionFormValues;

const WORKING = ['Looking over the photographs…', 'Checking the particulars…', 'Drafting the entry…'];

function Working() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => Math.min(s + 1, WORKING.length - 1)), 1100);
    return () => clearInterval(id);
  }, []);
  return (
    <div role="status" className="mt-5 border-t border-border pt-5">
      <p key={step} className="word-in font-serif text-lg italic">
        {WORKING[step]}
      </p>
      <div aria-hidden className="mt-4 flex flex-col gap-2.5">
        {['w-11/12', 'w-4/5', 'w-2/3'].map((width, i) => (
          <span key={width} className={`h-2 animate-pulse bg-muted ${width}`} style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </div>
    </div>
  );
}

// One proposed change: what it would become, and a button to accept it or put
// the seller's own text back.
function Proposal({
  label,
  applied,
  canUndo,
  onUse,
  onUndo,
  children,
}: {
  label: string;
  applied: boolean;
  canUndo: boolean;
  onUse: () => void;
  onUndo: () => void;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-x-4 gap-y-2 border-b border-border py-4 sm:grid-cols-[6.5rem_1fr_auto]">
      <p className="eyebrow pt-1.5">{label}</p>
      <div className="min-w-0">{children}</div>
      <div className="sm:text-right">
        {applied ? (
          <span className="inline-flex items-center gap-2 text-sm text-live">
            <IconCheck aria-hidden className="size-4" stroke={2} />
            In your listing
            {canUndo && (
              <button
                type="button"
                onClick={onUndo}
                className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                <IconArrowBackUp aria-hidden className="size-3.5" />
                Undo
              </button>
            )}
          </span>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={onUse}>
            Use<span className="sr-only"> suggested {label.toLowerCase()}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

export function ListingAssistant({
  accessToken,
  values,
  getDraft,
  hasMaterial,
  uploading,
  onApply,
}: {
  accessToken: string;
  // What is in the form right now, to show which suggestions are in use.
  values: Partial<CreateAuctionFormValues>;
  getDraft: () => ListingDraft;
  hasMaterial: boolean;
  uploading: boolean;
  onApply: (field: Field, value: string) => void;
}) {
  // What each field held before a suggestion replaced it.
  const [previous, setPrevious] = useState<Partial<Record<Field, string>>>({});

  const status = useQuery({
    queryKey: ['ai', 'status'],
    queryFn: () => getAiStatusRequest(accessToken),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const review = useMutation({
    mutationFn: () => suggestListingRequest(accessToken, getDraft()),
    onSuccess: () => setPrevious({}),
  });

  // No key on the server (or an older API): offer nothing rather than a button
  // that cannot work.
  if (!status.data?.listingAssistant) return null;

  const suggestion: ListingSuggestion | undefined = review.data?.suggestion;
  const description = values.description ?? '';

  const apply = (field: Field, value: string) => {
    setPrevious((before) => ({ ...before, [field]: values[field] ?? '' }));
    onApply(field, value);
  };
  const undo = (field: Field) => {
    const before = previous[field];
    if (before === undefined) return;
    onApply(field, before);
    setPrevious((all) => {
      const rest = { ...all };
      delete rest[field];
      return rest;
    });
  };
  const proposal = (field: Field, value: string, applied: boolean) => ({
    applied,
    canUndo: previous[field] !== undefined,
    onUse: () => apply(field, value),
    onUndo: () => undo(field),
  });

  const addDetail = (label: string) => {
    onApply('description', `${description.trimEnd()}\n${label}: `);
    // After the new text has rendered, put the cursor at the end of it.
    requestAnimationFrame(() => {
      const box = document.getElementById('description') as HTMLTextAreaElement | null;
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    });
  };
  // "Size: " added from the list and never filled in.
  const blankLines = (suggestion?.missingDetails ?? [])
    .map((detail) => detail.label)
    .filter((label) => description.split('\n').some((line) => line.trim() === `${label}:`));

  const categoryChange = suggestion?.category && suggestion.category !== values.category;
  const conditionChange = suggestion?.condition && suggestion.condition !== values.condition;

  const useAll = () => {
    if (!suggestion) return;
    apply('title', suggestion.title);
    apply('description', suggestion.description);
    if (suggestion.category) apply('category', suggestion.category);
    if (suggestion.condition) apply('condition', suggestion.condition);
  };

  return (
    <section aria-labelledby="cataloguer-heading" className="panel border-t-[3px] border-t-accent p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow flex items-center gap-1.5 text-accent!">
            <IconSparkles aria-hidden className="size-3.5" stroke={1.6} />
            AI assistant
          </p>
          <h2 id="cataloguer-heading" className="mt-1 text-2xl font-medium">
            Cataloguer&apos;s notes
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            A second pair of eyes on your title, description and photos. Nothing changes until you accept it.
          </p>
        </div>
        <Button
          type="button"
          className="btn-accent"
          onClick={() => review.mutate()}
          disabled={!hasMaterial || uploading || review.isPending}
        >
          {review.isPending ? 'Reviewing…' : suggestion ? 'Review again' : 'Review my listing'}
        </Button>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        {!hasMaterial
          ? 'Add a title or a photo first.'
          : uploading
            ? 'Waiting for your photos to finish uploading.'
            : 'Your title, description and up to two photos are sent to Groq, an outside AI service.'}
      </p>

      {review.isPending && <Working />}

      {review.isError && !review.isPending && (
        <div className="mt-4">
          <Notice tone="error">
            {review.error instanceof ApiError ? review.error.message : 'The review failed. Try again.'} You can still
            list your item without it.
          </Notice>
        </div>
      )}

      {suggestion && !review.isPending && (
        <div aria-live="polite" className="word-in mt-5 border-t-2 border-foreground">
          <Proposal label="Title" {...proposal('title', suggestion.title, values.title === suggestion.title)}>
            <p className="font-serif text-xl leading-snug">{suggestion.title}</p>
          </Proposal>

          <Proposal
            label="Description"
            {...proposal('description', suggestion.description, description.startsWith(suggestion.description))}
          >
            <p className="whitespace-pre-wrap font-serif text-base leading-7">{suggestion.description}</p>
          </Proposal>

          {suggestion.category && (categoryChange || previous.category !== undefined) && (
            <Proposal label="Category" {...proposal('category', suggestion.category, !categoryChange)}>
              <p className="font-serif text-lg">{formatCategory(suggestion.category)}</p>
            </Proposal>
          )}
          {suggestion.condition && (conditionChange || previous.condition !== undefined) && (
            <Proposal label="Condition" {...proposal('condition', suggestion.condition, !conditionChange)}>
              <p className="font-serif text-lg">{formatCategory(suggestion.condition)}</p>
              <p className="text-sm text-muted-foreground">{suggestion.conditionReason}</p>
            </Proposal>
          )}

          {suggestion.missingDetails.length > 0 && (
            <div className="border-b border-border py-4">
              <p className="eyebrow">Buyers will ask</p>
              <ul className="mt-2">
                {suggestion.missingDetails.map((detail) => {
                  const added = description.split('\n').some((line) => line.trim().startsWith(`${detail.label}:`));
                  return (
                    <li key={detail.label} className="flex items-center gap-3 py-1.5">
                      <span className="shrink-0 font-serif text-lg">{detail.label}</span>
                      <span className="min-w-0 flex-1 text-sm text-muted-foreground">{detail.why}</span>
                      <button
                        type="button"
                        onClick={() => addDetail(detail.label)}
                        disabled={added}
                        aria-label={`Add a ${detail.label} line to the description`}
                        className="inline-flex shrink-0 items-center gap-1 border border-border-strong px-2 py-1 text-xs transition-colors hover:border-accent hover:bg-accent-soft disabled:border-border disabled:text-muted-foreground"
                      >
                        {added ? <IconCheck aria-hidden className="size-3.5" /> : <IconPlus aria-hidden className="size-3.5" />}
                        {added ? 'Added' : 'Add'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {blankLines.length > 0 && (
                <p className="mt-2 text-sm text-accent">Still blank in your description: {blankLines.join(', ')}.</p>
              )}
            </div>
          )}

          {suggestion.photoTips.length > 0 && (
            <div className="border-b border-border py-4">
              <p className="eyebrow">Photographs to add</p>
              <ul className="mt-2 flex flex-col gap-2">
                {suggestion.photoTips.map((tip) => (
                  <li key={tip} className="flex gap-3 text-sm">
                    <IconCamera aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" stroke={1.4} />
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {suggestion.concerns.length > 0 && (
            <div className="mt-4">
              <Notice tone="error">
                <p className="font-medium">Worth checking</p>
                <ul className="mt-1 list-disc pl-4">
                  {suggestion.concerns.map((concern) => (
                    <li key={concern}>{concern}</li>
                  ))}
                </ul>
              </Notice>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-sm text-xs text-muted-foreground">
              AI can be wrong. Keep only what is true: you are responsible for your listing, and this does not confirm
              authenticity.
            </p>
            <Button type="button" size="sm" onClick={useAll}>
              Use all four
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
