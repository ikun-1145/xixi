export class VerifyError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "VerifyError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function toPublicError(error) {
  if (error instanceof VerifyError) {
    return {
      status: error.status,
      body: {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }

  console.error("verify_unhandled_error", error instanceof Error ? error.message : String(error));
  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "核验服务暂时无法完成请求，请稍后重试。",
      },
    },
  };
}

