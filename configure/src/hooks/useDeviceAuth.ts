import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

export interface DeviceAuthCode {
  sessionId: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
}

interface UseDeviceAuthOptions {
  /** Endpoint that starts the flow (POST), its polling counterpart (GET), and
   *  the one that drops a session the user gave up on (POST). */
  startPath: string;
  statusPath: string;
  cancelPath: string;
  /** Polling pauses while the dialog is closed. */
  active: boolean;
  providerLabel: string;
  onAuthorized: (tokenId: string, username: string) => void;
}

/**
 * Drives the Simkl PIN flow: ask the server for a code, show it, then poll
 * until the server has a token.
 */
export function useDeviceAuth({
  startPath,
  statusPath,
  cancelPath,
  active,
  providerLabel,
  onAuthorized,
}: UseDeviceAuthOptions) {
  const [code, setCode] = useState<DeviceAuthCode | null>(null);
  const [requesting, setRequesting] = useState(false);
  const onAuthorizedRef = useRef(onAuthorized);
  onAuthorizedRef.current = onAuthorized;

  const cancel = useCallback(() => {
    if (code) {
      // Best effort, the session expires on its own anyway.
      fetch(cancelPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: code.sessionId }),
      }).catch(() => undefined);
    }
    setCode(null);
  }, [cancelPath, code]);

  const start = useCallback(async () => {
    setRequesting(true);
    try {
      const response = await fetch(startPath, { method: 'POST' });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        toast.error(data?.error || `Could not start the ${providerLabel} authorization`);
        return;
      }
      const data = await response.json();
      setCode({
        sessionId: data.sessionId,
        userCode: data.userCode,
        verificationUrl: data.verificationUrl,
        interval: Math.max(2, Number(data.interval) || 5),
      });
      window.open(data.verificationUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error(`${providerLabel} device auth request error:`, error);
      toast.error(`Could not start the ${providerLabel} authorization`);
    } finally {
      setRequesting(false);
    }
  }, [startPath, providerLabel]);

  useEffect(() => {
    if (!code || !active) return;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`${statusPath}?sessionId=${encodeURIComponent(code.sessionId)}`);
        if (cancelled) return;

        // Rate limited, wait for the next tick.
        if (response.status === 429) return;

        const data = await response.json().catch(() => null);

        if (!response.ok && response.status !== 404) {
          toast.error(data?.error || `Could not check the ${providerLabel} authorization status`);
          setCode(null);
          return;
        }

        if (data?.status === 'authorized' && data.tokenId) {
          setCode(null);
          onAuthorizedRef.current(data.tokenId, data.username);
        } else if (data?.status === 'slow_down') {
          // Provider says we're polling too fast, so widen the gap.
          setCode(prev => (prev ? { ...prev, interval: prev.interval + 2 } : prev));
        } else if (data?.status === 'expired') {
          setCode(null);
          toast.error(`The ${providerLabel} code expired. Please request a new one.`);
        }
      } catch (error) {
        console.error(`${providerLabel} device auth status error:`, error);
      }
    }, code.interval * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [code, active, statusPath, providerLabel]);

  return { code, requesting, start, cancel };
}
