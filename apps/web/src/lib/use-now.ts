import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `intervalMs`. Components derive "how long ago" values from
 * it instead of calling Date.now() during render, which keeps renders pure and lets relative
 * labels ("Receiving", "2 min ago") update on their own.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
