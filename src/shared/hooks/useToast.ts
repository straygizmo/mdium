import { useRef, useState } from "react";

export function useToast() {
  const [toast, setToast] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string, isError = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, isError });
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  };

  return { toast, showToast } as const;
}
