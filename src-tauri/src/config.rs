//! 集中配置与常量，避免魔法数字散布在代码中。

/// 密钥环服务名
pub const KEYRING_SERVICE_NAME: &str = "dev.cofree.app";
/// 默认 API Key 键名
pub const KEYRING_DEFAULT_USER: &str = "litellm-api-key";

/// 工作区列表默认忽略的目录名
pub const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
];

/// HTTP fetch 允许的域名白名单
pub const FETCH_ALLOWED_DOMAINS: &[&str] = &[
    "api.github.com",
    "raw.githubusercontent.com",
    "docs.rs",
    "doc.rust-lang.org",
    "npmjs.com",
    "www.npmjs.com",
    "registry.npmjs.org",
    "pypi.org",
    "stackoverflow.com",
    "developer.mozilla.org",
    "crates.io",
    "pkg.go.dev",
    "docs.python.org",
    "nodejs.org",
    "typescriptlang.org",
    "www.typescriptlang.org",
    "reactjs.org",
    "react.dev",
    "vuejs.org",
    "angular.io",
    "svelte.dev",
    "nextjs.org",
    "deno.land",
    "bun.sh",
];

/// Grep 默认与最大结果数
pub const GREP_DEFAULT_MAX_RESULTS: usize = 50;
pub const GREP_ABSOLUTE_MAX_RESULTS: usize = 200;
/// Grep 遍历文件上限
pub const GREP_MAX_FILES: usize = 10_000;

/// Glob 默认与最大结果数
pub const GLOB_DEFAULT_MAX_RESULTS: usize = 100;
pub const GLOB_ABSOLUTE_MAX_RESULTS: usize = 500;

/// Shell 命令超时（毫秒）
pub const SHELL_TIMEOUT_DEFAULT_MS: u64 = 120_000;
pub const SHELL_TIMEOUT_MIN_MS: u64 = 1_000;
pub const SHELL_TIMEOUT_MAX_MS: u64 = 600_000;

/// HTTP fetch 默认最大 body 大小（字节）
pub const FETCH_DEFAULT_MAX_BYTES: usize = 512 * 1024;

/// 诊断输出截断长度
pub const DIAGNOSTICS_OUTPUT_TRUNCATE_LEN: usize = 3000;

/// 阻塞性 shell 命令黑名单（子串匹配，小写）
pub const SHELL_BLOCKED_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "mkfs",
    "shutdown",
    "reboot",
    ":(){:|:&};:",
];
