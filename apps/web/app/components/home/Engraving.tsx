import type { AuctionCategory } from '@/lib/types/auction';

// One line drawing per department, in the manner of a catalogue engraving.
// Only <path> elements, each with pathLength={1}, so the same CSS can draw any
// of them stroke by stroke (.engrave in globals.css).
const DRAWINGS: Record<AuctionCategory, string[]> = {
  WATCHES: [
    'M96 66l6-40h36l6 40',
    'M96 174l6 40h36l6-40',
    'M108 38h24M108 50h24M108 190h24M108 202h24',
    'M120 62a58 58 0 1 1-.1 0z',
    'M120 73a47 47 0 1 1-.1 0z',
    'M178 110h11v20h-11',
    'M120 80v8M120 152v8M80 120h8M152 120h8M92 92l5 5M143 143l5 5M148 92l-5 5M97 143l-5 5',
    'M120 120V92M120 120l24 14',
  ],
  BOOKS_AND_MANUSCRIPTS: [
    'M72 36h104a8 8 0 0 1 8 8v138H74a14 14 0 0 0-14 14V48a12 12 0 0 1 12-12z',
    'M60 196a14 14 0 0 0 14 14h110v-28',
    'M76 190h108M76 201h108',
    'M82 36v146',
    'M104 68h58M114 82h38',
    'M133 102l16 22-16 22-16-22z',
    'M133 116l6 8-6 8-6-8z',
    'M110 164h46',
    'M150 210v22l-9-8-9 8v-22',
  ],
  COLLECTIBLES: [
    'M36 156c0-24 5-48 15-62 10 10 25 13 37 5l11-15 20 11c15 19 33 31 62 37 23 5 31 12 31 24',
    'M34 156h178c0 15-9 24-25 24H56c-13 0-22-9-22-24z',
    'M42 168h162',
    'M58 180v-6M82 180v-6M106 180v-6M130 180v-6M154 180v-6M178 180v-6',
    'M96 102l19-11M108 115l19-11M121 127l18-10M135 136l16-9',
    'M60 136c24 9 55 3 100-23-31 31-62 45-86 43-12-1-18-10-14-20z',
    'M51 94c9 19 10 40 3 62',
    'M168 156c3-10 12-17 22-18',
  ],
  ART: [
    'M34 52h172v146H34z',
    'M50 68h140v114H50z',
    'M34 52l16 16M206 52l-16 16M34 198l16-16M206 198l-16-16',
    'M88 52l32-30 32 30',
    'M120 18a4 4 0 1 1-.1 0z',
    'M92 86a14 14 0 1 1-.1 0z',
    'M50 160l42-46 28 28 25-32 45 54',
    'M66 170h46M126 166h48M84 176h58',
  ],
  JEWELRY: [
    'M120 96a58 58 0 1 1-.1 0z',
    'M120 110a44 44 0 1 1-.1 0z',
    'M90 62l16-24h28l16 24-30 36z',
    'M90 62h60',
    'M106 38v24l14 36M134 38v24l-14 36',
    'M104 100l8 6M136 100l-8 6',
    'M62 34v20M52 44h20',
    'M180 66v14M173 73h14',
    'M170 30v8M166 34h8',
  ],
  COINS_AND_CURRENCY: [
    'M120 34a86 86 0 1 1-.1 0z',
    'M120 46a74 74 0 1 1-.1 0z',
    'M120 38v4M120 198v4M38 120h4M198 120h4M62 62l3 3M175 175l3 3M178 62l-3 3M65 175l-3 3',
    'M142 97c-4-11-13-15-23-15-13 0-22 7-22 18 0 25 47 12 47 39 0 12-11 20-25 20-13 0-23-6-27-18',
    'M120 70v12M120 159v12',
    'M70 148c6 18 20 30 36 35M170 148c-6 18-20 30-36 35',
    'M70 160l-8-2M80 172l-8 2M170 160l8-2M160 172l8 2',
  ],
  MEMORABILIA: [
    'M78 40h84v42c0 33-19 58-42 58s-42-25-42-58z',
    'M78 54H54c0 28 12 44 30 47',
    'M162 54h24c0 28-12 44-30 47',
    'M112 139v33M128 139v33',
    'M96 172h48l8 20H88z',
    'M74 192h92v18H74z',
    'M100 201h40',
    'M120 60l7 15 16 2-12 11 3 16-14-8-14 8 3-16-12-11 16-2z',
  ],
  OTHER: [
    'M120 36l76 40v90l-76 40-76-40V76z',
    'M44 76l76 40 76-40',
    'M120 116v90',
    'M82 56l76 40v30',
    'M72 62l76 40',
    'M60 128l30 16M60 142l18 10',
    'M146 168l30-16v18l-30 16z',
  ],
};

export function Engraving({ category, className = '' }: { category: AuctionCategory; className?: string }) {
  return (
    <svg
      viewBox="0 0 240 240"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`engrave ${className}`}
    >
      {DRAWINGS[category].map((d, i) => (
        <path key={d} d={d} pathLength={1} style={{ animationDelay: `${i * 90}ms` }} />
      ))}
    </svg>
  );
}
