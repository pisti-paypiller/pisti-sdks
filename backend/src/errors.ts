
export class PistiError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly code: string | null = null,
    ) {
        super(message);
        this.name = "PistiError";
    }
}
