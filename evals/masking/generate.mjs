// Builds the masking test cases. The secrets are fake and generated from a
// fixed seed at test time, so no secret-shaped text is stored in git (GitHub
// push protection rightly rejects that, even for fakes). Same seed, same cases.
// Run directly to write cases.jsonl for inspection: node evals/masking/generate.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export function buildCases() {
  let seed = 20261120;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (s, n) => Array.from({ length: n }, () => s[Math.floor(rnd() * s.length)]).join("");
  const AN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const HEX = "0123456789abcdef";
  const B32 = "abcdefghijklmnopqrstuvwxyz234567";
  const B64 = AN + "+/";
  const URL64 = AN + "-_";
  const pw = () => pick("abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ", 6) + pick("23456789", 2) + pick("!@#%", 1) + pick("abcdefgh", 3);
  
  const cases = [];
  let n = 0;
  const add = (expect, text, values = [], kinds) => {
    const c = { id: `${expect}-${String(++n).padStart(3, "0")}`, text, expect };
    if (kinds) c.kinds = kinds;
    if (values.length) c.values = values;
    cases.push(c);
  };
  
  // ---- block cases ----
  for (let i = 0; i < 3; i++) {
    const body = Array.from({ length: 3 }, () => pick(B64, 64)).join("\n");
    const t = ["RSA ", "EC ", "OPENSSH ", ""][i];
    add("block", `Here is the deploy key:\n-----BEGIN ${t}PRIVATE KEY-----\n${body}\n-----END ${t}PRIVATE KEY-----\nplease review`, [body.split("\n")[1]], ["PRIVATE_KEY"]);
  }
  add("block", `-----BEGIN PRIVATE KEY-----\n${pick(B64, 60)}`, [], ["PRIVATE_KEY"]);
  for (let i = 0; i < 4; i++) {
    const j = `eyJ${pick(URL64, 20)}.eyJ${pick(URL64, 40)}.${pick(URL64, 43)}`;
    add("block", [`token response: ${j}`, `{"id_token":"${j}"}`, `Authorization header was ${j} in the log`, `const jwt = '${j}';`][i], [j], ["JWT"]);
  }
  for (let i = 0; i < 4; i++) {
    const k = "AKIA" + pick(UP, 16);
    add("block", [`aws_access_key_id = ${k}`, `AWS_ACCESS_KEY_ID=${k}`, `"accessKey": "${k}"`, `use ${k} for the bucket`][i], [k], ["AWS_KEY"]);
  }
  for (let i = 0; i < 5; i++) {
    const k = ["ghp_", "gho_", "ghs_", "ghu_", "github_pat_"][i] + pick(AN, i === 4 ? 70 : 36);
    add("block", [`git clone https://x:${k}@github.com/o/r.git`, `GITHUB_TOKEN=${k}`, `token: ${k}`, `# ${k}`, `gh auth login --with-token <<< ${k}`][i], [k], ["GITHUB_TOKEN"]);
  }
  for (let i = 0; i < 4; i++) {
    const k = "sk-ant-api03-" + pick(URL64, 90);
    add("block", [`ANTHROPIC_API_KEY=${k}`, `{"x-api-key": "${k}"}`, `client = Anthropic(api_key="${k}")`, `my key is ${k}`][i], [k], ["ANTHROPIC_KEY"]);
  }
  for (let i = 0; i < 4; i++) {
    const k = ["sk-", "sk-proj-", "sk-", "sk-svcacct-"][i] + pick(AN, 48);
    add("block", [`OPENAI_API_KEY=${k}`, `openai.api_key = "${k}"`, `Authorization: ${k}`, `${k}`][i], [k], ["OPENAI_KEY"]);
  }
  for (let i = 0; i < 3; i++) {
    const k = "AIza" + pick(URL64, 35);
    add("block", [`GOOGLE_API_KEY=${k}`, `https://maps.example.test/api?key=${k}&v=3`, `const key = "${k}";`][i], [k], ["GOOGLE_KEY"]);
  }
  for (let i = 0; i < 4; i++) {
    const t = pick(AN + "._~+/", 40);
    add("block", [`Authorization: Bearer ${t}`, `curl -H "Authorization: Bearer ${t}" https://api.example.test`, `headers = { Authorization = "Bearer ${t}" }`, `bearer ${t}`][i], [t], ["BEARER_TOKEN"]);
  }
  {
    const p = [pw(), pw(), pw(), pw(), pw(), pw()];
    add("block", `Server=tcp:db.example.test,1433;Initial Catalog=Demo;User ID=svc;Password=${p[0]};Encrypt=True;`, [p[0]]);
    add("block", `Data Source=10.1.2.3;Database=Demo;User Id=sa;Pwd=${p[1]};`, [p[1]]);
    add("block", `Driver={ODBC Driver 18 for SQL Server};Server=db1;Database=x;Uid=app;Pwd=${p[2]};TrustServerCertificate=yes`, [p[2]]);
    add("block", `var cs = "Server=localhost;Database=Demo;User Id=app;Password=${p[3]};";\nusing var c = new SqlConnection(cs);`, [p[3]]);
    add("block", `{"ConnectionStrings":{"Default":"Server=db;Database=d;User Id=u;Password=${p[4]};"}}`, [p[4]]);
    add("block", `const DB: &str = "Server=db;Database=d;User Id=u;Password=${p[5]};";`, [p[5]]);
  }
  for (const [i, s] of ["postgres", "postgresql", "mongodb", "mongodb+srv", "mssql", "redis", "amqp", "mysql"].entries()) {
    const p = pw();
    add("block", [`DATABASE_URL=${s}://appuser:${p}@db.example.test:5432/demo`, `let url = "${s}://svc:${p}@host.example.test/db";`, `${s}://admin:${p}@10.0.0.5:27017/?authSource=admin`, `url: ${s}://reader:${p}@db/x`, `"${s}://u:${p}@h/d"`, `docker run -e URL=${s}://u:${p}@h/d img`, `connect("${s}://root:${p}@localhost")`, `${s}://x:${p}@y`][i], [p]);
  }
  {
    const p = pw();
    add("block", `password=${p}`, [p], ["PASSWORD_VALUE"]);
    add("block", `PASSWORD=${p}\nUSER=app`, [p]);
    add("block", `{"password": "${p}"}`, [p]);
    add("block", `{\n  "client_secret":\n     "${p}"\n}`, [p]);
    add("block", `[db]\npwd = ${p}\nhost = x`, [p]);
    add("block", `secret: '${p}'`, [p]);
    add("block", `api_key = "${p}"`, [p]);
    add("block", `DB_PASSWORD="${p}"`, [p]);
    add("block", `let password = "${p}";`, [p]);
    add("block", `string Token = "${p}";`, [p]);
    add("block", `passwd: ${p}`, [p]);
    add("block", `http://x.test/cb?token=${p}&state=1`, [p]);
    add("block", `Mixed Case: PassWord = "${p}"`, [p]);
    add("block", `export SECRET_TOKEN=${p}`, [p]);
  }
  for (let i = 0; i < 3; i++) {
    const pat = pick(B32, 52);
    add("block", [`AZURE_DEVOPS_PAT=${pat}`, `pat is ${pat}`, `https://dev.azure.com/org/_apis?auth=${pat}`][i], [pat], undefined);
  }
  for (let i = 0; i < 3; i++) {
    const sig = pick(AN, 43) + "%3D";
    add("block", `https://acct.blob.example.test/c/f.png?sv=2022-11-02&se=2030-01-01&sp=r&sig=${sig}`, [sig]);
    if (i === 2) break;
  }
  for (let i = 0; i < 4; i++) {
    const k = pick(AN + "+/", 40);
    add("block", [`aws_secret_access_key = ${k}`, `random value ${k} appears here`, `key: ${pick(AN, 32)}`, `"${pick(URL64, 44)}"`][i], [], undefined);
  }
  add("block", `hex key ${pick(HEX, 48)} in config`, [], ["HIGH_ENTROPY"]);
  {
    const k = pick(AN, 24);
    add("block", `Mixed: user ${"a@b.test"} and token ${k}${pick("0123", 4)}Zq9xWv2`, [k]);
    const t = pick(URL64, 43);
    add("block", `xoxb-${pick("0123456789", 11)}-${pick("0123456789", 12)}-${pick(AN, 24)}`, [], ["SLACK_TOKEN"]);
    add("block", `Email bob@corp.test then password: "${pw()}" and ip 10.1.1.5`, [], undefined);
    add("block", `// TODO remove\nconst x = {\n  host: "db",\n  pwd: "${pw()}",\n};`, []);
  }
  
  // ---- replace cases ----
  const ips = ["10.0.4.17", "192.168.1.20", "172.16.8.9", "172.31.255.1", "10.200.1.1", "192.168.100.254"];
  ips.forEach((ip, i) => add("replace", [`connect to ${ip} on port 1433`, `Server=${ip};Database=x`, `ping ${ip}`, `http://${ip}:8080/health`, `hosts: [${ip}, ${ip}]`, `${ip} is the QA box`][i], [ip], ["INTERNAL_IP"]));
  const emails = ["jane.doe@example.test", "support+qa@example.test", "a_b@sub.example.test", "ops-team@example.test", "first.last@mail.example.test"];
  emails.forEach((e, i) => add("replace", [`contact ${e} for access`, `git config user.email "${e}"`, `From: ${e}\nTo: ${e}`, `<${e}>`, `Reported by ${e}.`][i], [e], ["EMAIL"]));
  ["C:\\Users\\jsmith\\Documents\\x.txt", "c:\\users\\bkumar\\AppData\\Local\\app", "C:\\Users\\dev.user\\source\\repos"].forEach((p, i) => {
    const name = p.split("\\")[2];
    add("replace", `file at ${p}`, [name], ["USER_PATH"]);
  });
  add("replace", "path /home/alice/projects/aura", ["alice"], ["USER_PATH"]);
  add("replace", "opened /Users/bob/Library/x", ["bob"], ["USER_PATH"]);
  ["\\\\fileserver01\\shared\\specs", "\\\\NAS-2\\backup\\db", "\\\\corp.example.test\\dfs\\data"].forEach((p) => add("replace", `copy from ${p} now`, [p], ["UNC_PATH"]));
  add("replace", "Ping 10.0.0.8 and mail ops@example.test about it", ["10.0.0.8", "ops@example.test"], ["INTERNAL_IP", "EMAIL"]);
  // dictionary cases are marked with "dict": true; the test supplies the dictionary
  const dict = [["Acme Glass", "CUSTOMER"], ["Brightview", "CUSTOMER"], ["SQLPROD01", "INTERNAL_HOST"], ["cobalt_erp", "SCHEMA"], ["Zenith Fabricators", "CUSTOMER"]];
  const dc = (text, values, kinds) => { add("replace", text, values, kinds); cases[cases.length - 1].dict = true; };
  dc("Order from Acme Glass failed validation", ["Acme Glass"], ["CUSTOMER"]);
  dc("order from ACME GLASS and acme glass again", ["ACME GLASS", "acme glass"], ["CUSTOMER"]);
  dc("Brightview asked about Brightview's pricing", ["Brightview"], ["CUSTOMER"]);
  dc("Server SQLPROD01 timed out; sqlprod01 retry ok", ["SQLPROD01", "sqlprod01"], ["INTERNAL_HOST"]);
  dc("SELECT * FROM cobalt_erp.dbo.Orders", ["cobalt_erp"], ["SCHEMA"]);
  dc("Zenith Fabricators and Acme Glass share a rack", ["Zenith Fabricators", "Acme Glass"], ["CUSTOMER"]);
  dc("host sqlprod01 at 10.4.4.4", ["sqlprod01", "10.4.4.4"], ["INTERNAL_HOST", "INTERNAL_IP"]);
  
  // ---- clean cases ----
  const clean = [
    "Merge commit 9fceb02d0ae598e95dc970b74767f19372d61af8 into development",
    "git log shows e7e0b43 and c7298d6",
    "SHA-256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "md5 d41d8cd98f00b204e9800998ecf8427e",
    "id 550e8400-e29b-41d4-a716-446655440000 was created",
    "{\"id\":\"123e4567-e89b-12d3-a456-426614174000\"}",
    "const icon = 'data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" + "';",
    "<img src=\"data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg==\" />",
    "fn main() {\n    let v: Vec<u32> = (0..10).collect();\n    println!(\"{:?}\", v);\n}",
    "export function add(a: number, b: number): number { return a + b; }",
    "pub async fn handle_request(state: State<AppState>) -> Result<Json<Order>, ApiError> {",
    "The password field label should be translated.",
    "password field label",
    "Add a placeholder text to the Password input",
    "label: \"Password\", type: \"password\"",
    "password: string;",
    "token: string,",
    "let password = String::new();",
    "const token = getToken();",
    "password = password_input",
    "\"password\": \"Enter your password\"",
    "password=${DB_PASSWORD}",
    "api_key: process.env.API_KEY",
    "secret = <your secret here>",
    "SECRET_TOKEN=\"\"",
    "Version 1.2.3 released; node 26.0.1; tauri 2.9.5",
    "\"version\": \"0.1.0\", \"typescript\": \"^7.0.2\"",
    "color: #ff00ff; background: #1A2B3C; border: 1px solid rgb(10, 20, 30);",
    "--primary: 222.2 47.4% 11.2%;",
    "Open apps/aura-ui/src/components/aura/JobCard.tsx",
    "see docs/aura/software-factory.md and crates/agent-core/src/orders/mod.rs",
    "C:\\Developing\\ERP-MCP-SERVERS\\src\\index.ts",
    "D:\\SPIL AURA\\apps\\aura-ui",
    "cargo test -p agent-core --lib",
    "CARGO_BUILD_JOBS=1 cargo test",
    "The order has 12 panels and total area 3.4 square metres.",
    "https://github.com/DevAnuhas/plico-ui",
    "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
    "IPv4 example 8.8.8.8 and 1.1.1.1 are public",
    "version 10.0.26200 of Windows",
    "useEffect(() => { setCount((c) => c + 1); }, []);",
    "interface UserCredentials { username: string; }",
    "// tokenizer splits text into tokens",
    "const MAX_TOKENS = 4096;",
    "tokens: 5",
    "max_tokens=1024",
    "The secret to good glass cutting is measuring twice.",
    "sha512-" + "k".repeat(10) + " integrity placeholder",
    "ThisIsAVeryLongCamelCaseIdentifierName",
    "someVeryLongFunctionNameThatDoesSomething()",
    "kebab-case-long-identifier-name-for-css-class",
    "tailwind: className=\"flex min-w-0 items-center gap-2 text-muted-foreground\"",
    "SELECT Id, Name FROM Orders WHERE Id = @id",
    "import { loadConfig } from \"./config.ts\";",
    "node --test --experimental-strip-types engine/test/mask.test.ts",
    "Server=localhost;Database=Demo;Integrated Security=true;",
    "Trusted_Connection=True;Encrypt=True",
    "postgres://localhost:5432/demo",
    "mongodb://localhost:27017",
    "Contact the Aura team via the internal channel.",
    "RFC 4122 defines UUID layout",
    "git rev-parse HEAD returned 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "build 2026-11-20T10:15:30Z",
    "1234567890123456789012345",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "============================",
    "----------------------------------------",
    "The quick brown fox jumps over the lazy dog repeatedly and loudly",
    "/api/v1/orders/12345/panels/678",
    "src/components/plico/ThinkingState/index.tsx",
    "Bearer tokens are described in RFC 6750.",
    "Use a Bearer scheme in the Authorization header.",
    "dotnet add package Microsoft.Extensions.Logging.Abstractions --version 8.0.2",
    "Related notes: pattern-cochange-0829e6e17ce2 and choice-session-5444780fa8c8 (proposed).",
    "Repo key orders-app-540daa lives in the spool folder; see also my-repo-3c875a.",
    "See rule-no-hard-coding and pattern-cochange-091c8ef8f99f for the details.",
  ];
  clean.forEach((t) => add("clean", t));
  const gits = Array.from({ length: 6 }, () => pick(HEX, 40));
  gits.forEach((g, i) => add("clean", ["commit " + g, `fix: revert ${g.slice(0, 7)}`, `git show ${g}`, `parent ${g}\nauthor x`, `blob ${g} src/a.ts`, `${g}  HEAD`][i]));
  const uuids = Array.from({ length: 4 }, () => `${pick(HEX, 8)}-${pick(HEX, 4)}-4${pick(HEX, 3)}-a${pick(HEX, 3)}-${pick(HEX, 12)}`);
  uuids.forEach((u) => add("clean", `row id ${u}`));
  add("clean", `sha256 ${pick(HEX, 64)}`);
  add("clean", `md5 ${pick(HEX, 32)}`);
  

  // Cases added after tuning on real code; random tokens are placeholders
  // {{rand:<prefix>:<AN|URL64|B64>:<length>}} filled from the same seed.
  const SETS = { AN, URL64, B64 };
  const extra = readFileSync(join(HERE, "extra-cases.template.jsonl"), "utf8").trim().split(/\r?\n/);
  for (const line of extra) {
    const c = JSON.parse(line);
    c.text = c.text.replace(/\{\{rand:([^:}]*):(AN|URL64|B64):(\d+)\}\}/g, (_, pre, set, len) => pre + pick(SETS[set], Number(len)));
    cases.push(c);
  }
  return cases;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cases = buildCases();
  writeFileSync(join(HERE, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  const by = {};
  cases.forEach((c) => (by[c.expect] = (by[c.expect] ?? 0) + 1));
  console.log(cases.length, by);
}
