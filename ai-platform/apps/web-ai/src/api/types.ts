export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  environment: string;
  components: Record<string, string>;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    request_id?: string | null;
  };
}
