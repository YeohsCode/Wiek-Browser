import { type ReactNode } from "react";

// Shared 16×16 stroke-icon wrapper (Swiss style: currentColor, 1.5 stroke).
export default function Ico({ children, w = 16 }: { children: ReactNode; w?: number }) {
  return (
    <svg className="ico" width={w} height={w} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
      {children}
    </svg>
  );
}

// Exclamation mark for CAPTCHA-blocked tasks — replaces the status dot in a pill so
// an anti-bot wall reads apart from a red error at a glance. Shared by Progress and Judge.
export function CaptchaIco({ w = 11 }: { w?: number }) {
  return (
    <Ico w={w}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.8v3.6M8 10.9h.01" strokeLinecap="round" />
    </Ico>
  );
}
