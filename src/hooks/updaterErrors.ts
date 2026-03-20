export type UpdateErrorKind = "cancelled" | "verification" | "install" | "generic";

export interface ClassifiedUpdateError {
  kind: UpdateErrorKind;
  message: string;
}

export function classifyUpdateError(error: unknown): ClassifiedUpdateError {
  const message = (error instanceof Error ? error.message : String(error)).trim() || "未知错误";

  if (/cancel/i.test(message)) {
    return {
      kind: "cancelled",
      message: "更新已取消。",
    };
  }

  if (/signature|verify|pubkey|public key/i.test(message)) {
    return {
      kind: "verification",
      message: "自动更新签名校验失败，请联系开发者检查发布签名或更新公钥。",
    };
  }

  if (/install|extract|replace|mount|permission|os error 13/i.test(message)) {
    return {
      kind: "install",
      message: "更新包已下载，但安装失败。请关闭应用后手动安装，或稍后重试。",
    };
  }

  return {
    kind: "generic",
    message,
  };
}
