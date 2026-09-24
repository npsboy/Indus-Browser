import { useEffect, useState } from "react";

export function useLoadingText(isLoading: boolean) {
  const [dotCount, setDotCount] = useState(0);

  useEffect(() => {
    if (!isLoading) {
      setDotCount(0);
      return;
    }

    const intervalId = window.setInterval(() => {
      setDotCount((current) => (current + 1) % 4);
    }, 400);

    return () => window.clearInterval(intervalId);
  }, [isLoading]);

  return `Loading${dotCount > 0 ? ` ${".".repeat(dotCount)}` : ""}`;
}
