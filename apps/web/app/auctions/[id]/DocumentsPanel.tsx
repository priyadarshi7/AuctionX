'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { ApiError } from '@/lib/apiClient';
import {
  checkDocumentFile,
  DOCUMENT_ACCEPT,
  listDocumentsRequest,
  MAX_DOCUMENTS,
  removeDocumentRequest,
  uploadDocument,
} from '@/lib/documents';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Supporting paperwork for a listing (ADR-0041). `editable` is the seller
// working on a draft; read-only is the seller after submitting, or an admin
// reviewing. Links are short-lived signed URLs, so the list is refetched
// before they expire rather than left to go stale on a long-open page.
export function DocumentsPanel({
  auctionId,
  accessToken,
  editable,
}: {
  auctionId: string;
  accessToken: string;
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const queryKey = ['documents', auctionId];

  const docs = useQuery({
    queryKey,
    queryFn: () => listDocumentsRequest(accessToken, auctionId),
    refetchInterval: 4 * 60 * 1000,
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const problem = checkDocumentFile(file);
      if (problem) throw new Error(problem);
      await uploadDocument(accessToken, auctionId, file);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const remove = useMutation({
    mutationFn: (documentId: string) => removeDocumentRequest(accessToken, auctionId, documentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const documents = docs.data?.documents ?? [];
  const error = [upload.error, remove.error, docs.error].find(Boolean);
  const errorMessage =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : error ? 'Something went wrong.' : null;
  const full = documents.length >= MAX_DOCUMENTS;

  return (
    <div>
      {docs.isLoading && <p className="text-sm text-ink/60">Loading documents…</p>}
      {!docs.isLoading && documents.length === 0 && (
        <p className="text-sm text-ink/70">{editable ? 'No documents yet.' : 'No documents were attached.'}</p>
      )}
      {documents.length > 0 && (
        <ul className="overflow-hidden rounded-xl border-2 border-line bg-white">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center justify-between gap-3 border-b border-line/10 px-3 py-2 text-sm last:border-b-0"
            >
              <a
                href={doc.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate font-semibold underline underline-offset-4"
              >
                {doc.fileName}
              </a>
              <span className="flex shrink-0 items-center gap-3">
                <span className="text-ink/60">{formatSize(doc.sizeBytes)}</span>
                {editable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(doc.id)}
                    aria-label={`Remove ${doc.fileName}`}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <div className="mt-3">
          <input
            ref={fileInput}
            type="file"
            accept={DOCUMENT_ACCEPT}
            className="sr-only"
            id={`doc-upload-${auctionId}`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) upload.mutate(file);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={upload.isPending || full}
            onClick={() => fileInput.current?.click()}
          >
            {upload.isPending ? 'Uploading…' : full ? `Limit of ${MAX_DOCUMENTS} reached` : 'Add a document'}
          </Button>
          <p className="mt-1.5 text-xs text-ink/60">PDF, JPG, PNG or WebP, up to 10 MB each.</p>
        </div>
      )}
      {errorMessage && (
        <div className="mt-3">
          <Notice tone="error">{errorMessage}</Notice>
        </div>
      )}
    </div>
  );
}
