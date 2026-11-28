// Safe, stable diagnostics shared by the Edge Function and Node tests.
export function classifySearchFailure(error) {
  if (error?.code === "SEARCH_CONFIG_MISSING") return {code:"search_provider_not_configured", message:"搜索服务尚未完成配置，请联系管理员。"};
  if (error?.code === "PROVIDER_HTTP_ERROR") return {code:"search_provider_http_error", message:"搜索供应商暂时拒绝了请求，请稍后重试。"};
  if (error instanceof SyntaxError || error?.code === "PROVIDER_JSON_INVALID" || error?.code === "PROVIDER_INVALID_JSON") return {code:"search_provider_invalid_json", message:"搜索供应商返回了无法读取的数据，请稍后重试。"};
  if (error?.code === "PROVIDER_INVALID_RESPONSE") return {code:"search_provider_invalid_response", message:"搜索供应商返回的数据格式无效，请稍后重试。"};
  if (error?.name === "TimeoutError" || error?.name === "AbortError" || error?.code === "PROVIDER_TIMEOUT") return {code:"search_provider_timeout", message:"搜索供应商响应超时，请稍后重试。"};
  return {code:"search_internal_error", message:"搜索服务暂时遇到问题，请稍后重试。"};
}

export function logSearchFailure({requestId, stage, provider, error, log = console.error}) {
  const diagnostic = classifySearchFailure(error);
  // Never log request bodies, auth headers, provider URLs, or exception messages.
  log(JSON.stringify({event:"leads_search_failure", requestId, stage, provider:provider || "unconfigured", code:diagnostic.code,
    exceptionType: error?.name || "Error", providerStatus:Number.isInteger(error?.status) ? error.status : undefined}));
  return diagnostic;
}
