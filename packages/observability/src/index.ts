export interface LogContext {
  correlationId: string;
  sportKey?: string;
  eventId?: string;
}

export interface LoggerPort {
  info(message: string, context: LogContext): void;
  error(message: string, context: LogContext): void;
}
