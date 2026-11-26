'use client';

import { useEffect, useState } from 'react';

// Remaining milliseconds, ticking once a second. Display only: the server
// decides when an auction actually ends (Section 18).
function useRemainingMs(endTime: string | null): number | null {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!endTime) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endTime]);

  if (!endTime) return null;
  return Math.max(0, new Date(endTime).getTime() - now);
}

const URGENT_MS = 60_000;
const FINAL_HOUR_MS = 3_600_000;

function parts(ms: number) {
  const total = Math.floor(ms / 1000);
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

const two = (n: number) => String(n).padStart(2, '0');

// One line, for lists and cards: "2d 04h 13m" or "04:13:09".
export function Countdown({ endTime, className = '' }: { endTime: string | null; className?: string }) {
  const ms = useRemainingMs(endTime);
  if (ms === null) return <span className={className}>—</span>;
  if (ms === 0) return <span className={className}>Closed</span>;
  const { days, hours, minutes, seconds } = parts(ms);
  const text = days > 0 ? `${days}d ${two(hours)}h ${two(minutes)}m` : `${two(hours)}:${two(minutes)}:${two(seconds)}`;
  return <span className={`figures ${ms < URGENT_MS ? 'text-urgent' : ''} ${className}`}>{text}</span>;
}

// The saleroom clock: large ruled cells, plus a line that drains across the
// final hour so "nearly over" is visible without reading the digits.
export function SaleClock({ endTime }: { endTime: string | null }) {
  const ms = useRemainingMs(endTime);
  if (ms === null) return <p className="figures text-3xl">—</p>;
  if (ms === 0) return <p className="figures text-3xl">Closed</p>;

  const { days, hours, minutes, seconds } = parts(ms);
  const cells = [
    ...(days > 0 ? [{ value: days, unit: 'Days' }] : []),
    { value: hours, unit: 'Hrs' },
    { value: minutes, unit: 'Min' },
    { value: seconds, unit: 'Sec' },
  ];
  const urgent = ms < URGENT_MS;

  return (
    <div className="inline-block">
      {/* Read as one phrase; the cells below are decorative to a screen reader. */}
      <span className="sr-only">
        {days > 0 ? `${days} days ` : ''}
        {hours} hours {minutes} minutes {seconds} seconds remaining
      </span>
      <div aria-hidden className={`flex border border-border-strong ${urgent ? 'border-urgent text-urgent' : ''}`}>
        {cells.map((cell, i) => (
          <div key={cell.unit} className={`min-w-16 px-3 py-2 text-center ${i > 0 ? 'border-l border-border' : ''}`}>
            <div className="figures text-3xl leading-none">{two(cell.value)}</div>
            <div className="eyebrow mt-1.5">{cell.unit}</div>
          </div>
        ))}
      </div>
      {ms < FINAL_HOUR_MS && (
        <div aria-hidden className="mt-1.5">
          <div className="h-0.5 bg-border">
            <div
              className={`h-full transition-[width] duration-1000 ease-linear ${urgent ? 'bg-urgent' : 'bg-accent'}`}
              style={{ width: `${(ms / FINAL_HOUR_MS) * 100}%` }}
            />
          </div>
          <p className="eyebrow mt-1.5">Final hour</p>
        </div>
      )}
    </div>
  );
}
