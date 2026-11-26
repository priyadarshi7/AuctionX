'use client';

import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { Notice } from '../components/ui/Notice';

// Inline confirm step for any admin action that takes something away. A
// reason is required (the server enforces it too and writes it to the audit
// log), so the admin has to say why before the button works.
export function ReasonForm({
  prompt,
  confirmLabel,
  pending,
  error,
  reasonRequired = true,
  onConfirm,
  onCancel,
}: {
  prompt: string;
  confirmLabel: string;
  pending: boolean;
  error: string | null;
  reasonRequired?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const valid = !reasonRequired || trimmed.length >= 3;

  return (
    <form
      className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-surface-muted p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onConfirm(trimmed);
      }}
    >
      <label className="text-sm font-medium">
        {prompt}
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={500}
          required={reasonRequired}
          autoFocus
          className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-primitive-ring"
          placeholder={reasonRequired ? 'At least 3 characters. Saved to the audit log.' : 'Optional'}
        />
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={!valid || pending}>
          {pending ? 'Working…' : confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
