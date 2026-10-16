import { Auth } from "./auth.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";

/**
 * Server-side maintenance commands, run inside the hub container (scripts/install.sh wraps them):
 *   node src/cli.ts reset-password [--disable-totp]   new password on stdin
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "reset-password") {
    const password = await readStdin();
    const db = openDb(config.dbPath);
    new Auth(db).resetPassword(password, { disableTotp: args.includes("--disable-totp") });
    db.close();
    console.log(args.includes("--disable-totp") ? "密码已重置，两步验证已关闭，所有设备已退出登录。" : "密码已重置，所有设备已退出登录。");
  } else {
    console.error("用法：node src/cli.ts reset-password [--disable-totp]（新密码从标准输入读取）");
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
