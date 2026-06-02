export class MigrationInterruptedError extends Error {
  constructor(message = 'Migration interrupted by shutdown request') {
    super(message);
    this.name = 'MigrationInterruptedError';
  }
}

export function isMigrationInterruptedError(err: unknown): err is MigrationInterruptedError {
  return err instanceof MigrationInterruptedError;
}

export type MigrationShutdownController = {
  readonly signal: AbortSignal;
  request(reason?: string): void;
  isRequested(): boolean;
  reason(): string | undefined;
  throwIfRequested(): void;
};

export function createMigrationShutdownController(
  parentSignal?: AbortSignal,
): MigrationShutdownController {
  const controller = new AbortController();
  let reason: string | undefined;

  const request = (nextReason?: string): void => {
    if (controller.signal.aborted) return;
    reason = nextReason;
    controller.abort(nextReason);
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      request(reasonFromSignal(parentSignal));
    } else {
      parentSignal.addEventListener('abort', () => request(reasonFromSignal(parentSignal)), {
        once: true,
      });
    }
  }

  return {
    signal: controller.signal,
    request,
    isRequested: () => controller.signal.aborted,
    reason: () => reason,
    throwIfRequested: () => {
      if (controller.signal.aborted) {
        throw new MigrationInterruptedError(
          reason ? `Migration interrupted: ${reason}` : undefined,
        );
      }
    },
  };
}

function reasonFromSignal(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  return typeof reason === 'string'
    ? reason
    : reason instanceof Error
      ? reason.message
      : undefined;
}
