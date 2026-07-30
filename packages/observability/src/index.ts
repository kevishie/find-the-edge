export interface LogContext {
  correlationId: string;
  sportKey?: string;
  leagueKey?: string;
  capability?: string;
  providerId?: string;
  reason?: string;
  eventId?: string;
}

export interface LoggerPort {
  info(message: string, context: LogContext): void;
  error(message: string, context: LogContext): void;
}
