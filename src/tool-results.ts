// Preserve readable text for existing clients while exposing machine-readable results.
export function toolResult<T extends Record<string, unknown>>(data: T, text: string) {
    return { content: [{ type: 'text' as const, text }], structuredContent: data };
}

export function toolError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: message }], isError: true };
}
