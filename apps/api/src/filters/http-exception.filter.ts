import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithContext } from '../common/request-id.middleware';

const ERROR_NAMES: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
};

/**
 * Catches every exception. NEVER leaks SQL errors, stack traces, internal
 * service names, or DB table/column names in the HTTP response -- those go
 * only to the server-side log line, keyed by requestId.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<RequestWithContext>();
    const requestId = req.requestId ?? 'unknown';
    const timestamp = new Date().toISOString();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // status comes from HttpException.getStatus(), a closed set of numeric
      // HTTP status codes -- not arbitrary/external input.
      // eslint-disable-next-line security/detect-object-injection
      const errorName = ERROR_NAMES[status] ?? 'ERROR';
      const extra =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : ({} as Record<string, unknown>);

      const payload: Record<string, unknown> = {
        error: errorName,
        code: `E${status}`,
        requestId,
        timestamp,
      };
      if (status === HttpStatus.BAD_REQUEST) {
        payload.details = extra.fieldErrors ?? extra.formErrors ?? extra;
      }
      if (status === HttpStatus.CONFLICT && 'detail' in extra) {
        payload.detail = extra.detail;
      }

      res.status(status).json(payload);
      return;
    }

    this.logger.error(
      JSON.stringify({
        msg: 'unhandled_exception',
        requestId,
        error: exception instanceof Error ? exception.message : String(exception),
      }),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: 'INTERNAL_ERROR',
      code: 'E500',
      requestId,
      timestamp,
    });
  }
}
