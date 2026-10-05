import {
  BillingClient,
  BillingError,
  BillingFile,
  BillingFileKind,
  EmitRequest,
  EmitResult,
  TicketResult,
} from './billing-client';

export interface HttpBillingOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
}

interface ErrorBody {
  code?: string;
  message?: string;
  sunatCode?: string;
  retryable?: boolean;
}

/** Implementación HTTP de `BillingClient` sobre `openapi/billing.yaml`. */
export class HttpBillingClient implements BillingClient {
  constructor(
    private readonly options: HttpBillingOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  emit(request: EmitRequest): Promise<EmitResult> {
    return this.json<EmitResult>('POST', '/v1/documents', request);
  }

  async getStatus(externalId: string): Promise<EmitResult | null> {
    return this.jsonOrNull<EmitResult>(
      `/v1/documents/${encodeURIComponent(externalId)}`,
    );
  }

  async downloadFile(
    externalId: string,
    kind: BillingFileKind,
  ): Promise<BillingFile | null> {
    const response = await this.send(
      'GET',
      `/v1/documents/${encodeURIComponent(externalId)}/files/${kind}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await this.toError(response);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType:
        response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  void(
    externalId: string,
    request: { reason: string; voidDate: string },
  ): Promise<TicketResult> {
    return this.json<TicketResult>(
      'POST',
      `/v1/documents/${encodeURIComponent(externalId)}/void`,
      request,
    );
  }

  getTicket(ticket: string): Promise<TicketResult | null> {
    return this.jsonOrNull<TicketResult>(
      `/v1/tickets/${encodeURIComponent(ticket)}`,
    );
  }

  // ------------------------------------------------------------------

  private async json<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.send(method, path, body);
    if (!response.ok) throw await this.toError(response);
    return (await response.json()) as T;
  }

  private async jsonOrNull<T>(path: string): Promise<T | null> {
    const response = await this.send('GET', path);
    if (response.status === 404) return null;
    if (!response.ok) throw await this.toError(response);
    return (await response.json()) as T;
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.serviceToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      // Red caída o tiempo agotado: se reintenta con la misma externalId.
      throw new BillingError(
        error instanceof Error ? error.message : 'Billing is unreachable',
        'UNREACHABLE',
        0,
        true,
      );
    }
  }

  private async toError(response: Response): Promise<BillingError> {
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      // cuerpo vacío o no JSON
    }
    const status = response.status;
    // 401 es configuración (token): se reintenta hasta que alguien lo corrija.
    const retryable =
      body.retryable ?? (status === 502 || status === 503 || status === 401);
    return new BillingError(
      body.message ?? `Billing answered ${status}`,
      body.code ?? (status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR'),
      status,
      retryable,
      body.sunatCode,
    );
  }
}
