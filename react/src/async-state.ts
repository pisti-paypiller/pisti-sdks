import { useCallback, useEffect, useRef, useState } from "react";

export function useResource<T>(load: () => Promise<T>) {
    const [result, setResult] = useState<{
        owner: () => Promise<T>;
        data: T | null;
        error: Error | null;
        isLoading: boolean;
    }>({ owner: load, data: null, error: null, isLoading: true });
    const [version, setVersion] = useState(0);
    useEffect(() => {
        let active = true;
        setResult((previous) => ({
            owner: load,
            data: previous.owner === load ? previous.data : null,
            error: null,
            isLoading: true,
        }));
        void load().then(
            (value) => {
                if (active)
                    setResult({
                        owner: load,
                        data: value,
                        error: null,
                        isLoading: false,
                    });
            },
            (failure: unknown) => {
                if (active)
                    setResult((previous) => ({
                        owner: load,
                        data: previous.owner === load ? previous.data : null,
                        error:
                            failure instanceof Error
                                ? failure
                                : new Error("Unable to load this information."),
                        isLoading: false,
                    }));
            },
        );
        return () => {
            active = false;
        };
    }, [load, version]);
    const reload = useCallback(() => setVersion((value) => value + 1), []);
    const current =
        result.owner === load
            ? result
            : { data: null, error: null, isLoading: true };
    return {
        data: current.data,
        error: current.error,
        isLoading: current.isLoading,
        reload,
    };
}

export function useAction() {
    const running = useRef(false);
    const [isPending, setPending] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const run = async <T>(
        task: () => Promise<T>,
        message?: string,
    ): Promise<T | undefined> => {
        if (running.current) return undefined;
        running.current = true;
        setPending(true);
        setError(null);
        setSuccess(null);
        try {
            const result = await task();
            setSuccess(message ?? null);
            return result;
        } catch (failure) {
            setError(
                failure instanceof Error
                    ? failure
                    : new Error("The operation could not be completed."),
            );
            return undefined;
        } finally {
            running.current = false;
            setPending(false);
        }
    };
    const reset = useCallback(() => {
        setError(null);
        setSuccess(null);
    }, []);
    return { run, isPending, error, success, reset };
}
