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

/// 已完成 shell job 在内存中保留的最大条数（超过则按 FIFO 淘汰最旧条目）。
pub const SHELL_COMPLETED_JOBS_MAX: usize = 200;
/// 已完成 shell job 的存活时间（秒）。超过此时长的条目被惰性清除。
pub const SHELL_COMPLETED_JOB_TTL_SECS: u64 = 24 * 60 * 60;

/// HTTP fetch 默认最大 body 大小（字节）
pub const FETCH_DEFAULT_MAX_BYTES: usize = 512 * 1024;

/// 诊断输出截断长度
pub const DIAGNOSTICS_OUTPUT_TRUNCATE_LEN: usize = 3000;

/// Repo-Map 扫描限制
pub const REPO_MAP_MAX_FILES: usize = 200;
pub const REPO_MAP_MAX_FILE_SIZE: u64 = 100_000;
pub const REPO_MAP_MAX_SYMBOLS_PER_FILE: usize = 30;
pub const REPO_MAP_SIGNATURE_MAX_LEN: usize = 120;

/// 阻塞性 shell 命令黑名单（子串匹配，小写）
pub const SHELL_BLOCKED_PATTERNS: &[&str] = &[
    "rm -rf /",
    "rm -rf /*",
    "mkfs",
    "shutdown",
    "reboot",
    ":(){:|:&};:",
];

/// 交互式提示检测模式（在输出块中做子串匹配，不区分大小写）
/// 当检测到这些模式时，会触发 waiting_for_input 事件通知前端和 Agent。
/// 注意：stdin 已设为 /dev/null，读取会得到 EOF，但检测可帮助 Agent 
/// 理解为何命令失败并改用 --yes 等非交互参数。
pub const INTERACTIVE_PROMPT_PATTERNS: &[&str] = &[
    "(y/n)",
    "(y/n/a)",
    "(yes/no)",
    "[y/n]",
    "[y/n/a]",
    "[yes/no]",
    "proceed?",
    "continue?",
    "are you sure",
    "do you want to continue",
    "do you want to proceed",
    "password:",
    "passphrase:",
    "press any key",
    "press enter",
    "press return",
    "hit enter",
    "type 'yes'",
    "type \"yes\"",
];
