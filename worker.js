const SOURCE_CHANNEL = "1542165450207527094";
const RESULT_CHANNEL = "1542167671154409563";

const WOS_API =
  "https://wos-giftcode-api.centurygame.com/api/gift_code";

const WOS_KEY = "tB87#kPtkxqOS2";

export default {
  async fetch(request, env) {
    await ensureDatabase(env);

    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      url.pathname === "/register"
    ) {
      return registerMember(request, env);
    }

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return new Response(REGISTRATION_PAGE, {
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
        },
      });
    }

    return new Response("Not Found", {
      status: 404,
    });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
};

async function runScheduled(env) {
  await ensureDatabase(env);
  await checkDiscord(env);
}

async function ensureDatabase(env) {
  if (!env.MEMBERS_DB) {
    throw new Error("MEMBERS_DB が未設定です");
  }

  await env.MEMBERS_DB.batch([
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_name TEXT NOT NULL,
        player_id TEXT NOT NULL,
        kingdom_id TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(player_id, kingdom_id)
      )
    `),

    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS processed_codes (
        code TEXT NOT NULL,
        member_id INTEGER NOT NULL,
        err_code TEXT NOT NULL,
        message TEXT,
        processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(code, member_id)
      )
    `),
  ]);

  await env.MEMBERS_DB.prepare(`
    INSERT OR IGNORE INTO members
    (
      player_name,
      player_id,
      kingdom_id
    )
    VALUES (?, ?, ?)
  `)
    .bind(
      "シュガー",
      "441788306",
      "3338",
    )
    .run();
}

async function registerMember(request, env) {
  const form = await request.formData();

  const playerName = String(
    form.get("player_name") || "",
  ).trim();

  const playerId = String(
    form.get("player_id") || "",
  ).trim();

  const kingdomId = String(
    form.get("kingdom_id") || "",
  ).trim();

  if (
    playerName.length < 1 ||
    playerName.length > 30
  ) {
    return pageMessage(
      "登録できません",
      "名前は1〜30文字で入力してください。",
      false,
    );
  }

  if (!/^\d{6,15}$/.test(playerId)) {
    return pageMessage(
      "登録できません",
      "プレイヤーIDは6〜15桁の数字で入力してください。",
      false,
    );
  }

  if (
    !/^\d{1,6}$/.test(kingdomId) ||
    Number(kingdomId) < 1
  ) {
    return pageMessage(
      "登録できません",
      "王国番号を数字で入力してください。",
      false,
    );
  }

  const count =
    await env.MEMBERS_DB.prepare(`
      SELECT COUNT(*) AS total
      FROM members
      WHERE active = 1
    `).first();

  if (Number(count?.total || 0) >= 500) {
    return pageMessage(
      "登録できません",
      "登録上限に達しています。管理者へ連絡してください。",
      false,
    );
  }

  try {
    await env.MEMBERS_DB.prepare(`
      INSERT INTO members
      (
        player_name,
        player_id,
        kingdom_id
      )
      VALUES (?, ?, ?)
    `)
      .bind(
        playerName,
        playerId,
        kingdomId,
      )
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      return pageMessage(
        "登録済みです",
        "このプレイヤーIDと王国番号はすでに登録されています。",
        true,
      );
    }

    throw error;
  }

  return pageMessage(
    "登録完了！",
    `${escapeHtml(playerName)}さんを王国${escapeHtml(
      kingdomId,
    )}で登録しました。次回から新しいギフトコードを自動受取します。`,
    true,
  );
}

async function checkDiscord(env) {
  if (!env.DISCORD_BOT_TOKEN) {
    throw new Error(
      "DISCORD_BOT_TOKEN が未設定です",
    );
  }

  const response = await fetch(
    `https://discord.com/api/v10/channels/${SOURCE_CHANNEL}/messages?limit=20`,
    {
      headers: {
        Authorization:
          `Bot ${env.DISCORD_BOT_TOKEN}`,

        "User-Agent":
          "WOSGiftAuto (https://workers.cloudflare.com, 2.0)",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `Discord読取エラー: HTTP ${response.status}`,
    );
  }

  const messages = await response.json();
  const codes = new Set();

  for (
    const message of [...messages].reverse()
  ) {
    const text = [
      message.content || "",

      ...(message.embeds || []).flatMap(
        (embed) => [
          embed.title || "",
          embed.description || "",

          ...(embed.fields || []).map(
            (field) =>
              `${field.name} ${field.value}`,
          ),
        ],
      ),
    ].join("\n");

    for (
      const match of text.matchAll(
        /(?:gift\s*code|code)\s*[:：]\s*([A-Za-z0-9_-]{4,64})/gi,
      )
    ) {
      codes.add(match[1]);
    }
  }

  for (const code of codes) {
    await processCodeForMembers(
      code,
      env,
    );
  }
}

async function processCodeForMembers(
  code,
  env,
) {
  const { results: members = [] } =
    await env.MEMBERS_DB.prepare(`
      SELECT
        m.id,
        m.player_name,
        m.player_id,
        m.kingdom_id
      FROM members m
      LEFT JOIN processed_codes p
        ON p.member_id = m.id
        AND p.code = ?
      WHERE m.active = 1
        AND p.member_id IS NULL
      ORDER BY m.id
      LIMIT 500
    `)
      .bind(code)
      .all();

  if (members.length === 0) {
    return;
  }

  let success = 0;
  let already = 0;
  let failed = 0;
  let retry = 0;

  /*
   * 保存して処理を終了する結果。
   *
   * これ以外のエラーは処理済みに保存せず、
   * 次の毎分処理で自動的に再試行する。
   */
  const finalCodes = new Set([
    "20000", // 受取成功
    "40005", // 無効コードなど
    "40006", // 無効コードなど
    "40007", // 期限・時刻エラー
    "40008", // 受取済み
    "40010", // 交換不可
    "40011", // 同種報酬を交換済み
    "40014", // プレイヤー情報エラー
    "40020", // 王国・プレイヤー情報エラー
  ]);

  for (const member of members) {
    const result = await redeem(
      code,
      member.player_id,
      member.kingdom_id,
    );

    /*
     * 40004のタイムアウトや、
     * 未知の一時的エラーは保存しない。
     *
     * 次の1分後に同じ人へ再送する。
     */
    if (!finalCodes.has(result.errCode)) {
      retry++;
      continue;
    }

    await env.MEMBERS_DB.prepare(`
      INSERT OR REPLACE
      INTO processed_codes
      (
        code,
        member_id,
        err_code,
        message
      )
      VALUES (?, ?, ?, ?)
    `)
      .bind(
        code,
        member.id,
        result.errCode,
        result.message,
      )
      .run();

    if (result.errCode === "20000") {
      success++;
    } else if (
      [
        "40008",
        "40011",
      ].includes(result.errCode)
    ) {
      already++;
    } else {
      failed++;
    }
  }

  /*
   * 全員が再試行待ちの場合、
   * 毎分Discordへ同じ通知を送らない。
   */
  if (
    success +
      already +
      failed ===
    0
  ) {
    return;
  }

  await sendDiscord(
    env,
    `🎁 **ギフトコード自動交換結果**
コード：\`${code}\`
✅ 受取成功：${success}人
☑️ 受取済み：${already}人
🔄 再試行待ち：${retry}人
⚠️ その他：${failed}人`,
  );
}

async function redeem(
  code,
  playerId,
  kingdomId,
) {
  const time = Math.floor(
    Date.now() / 1000,
  ).toString();

  const sign = md5(
    `cdk=${code}&fid=${playerId}&kid=${kingdomId}&time=${time}${WOS_KEY}`,
  );

  const body = new URLSearchParams({
    cdk: code,
    fid: playerId,
    kid: kingdomId,
    time,
    sign,
  });

  const response = await fetch(WOS_API, {
    method: "POST",

    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",

      Accept:
        "application/json, text/plain, */*",

      Origin:
        "https://wos-giftcode.centurygame.com",

      Referer:
        "https://wos-giftcode.centurygame.com/",

      "User-Agent":
        "Mozilla/5.0 AppleWebKit/537.36 Chrome/134 Safari/537.36",
    },

    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(
      `ホワサバAPIエラー: HTTP ${response.status}`,
    );
  }

  const data = await response.json();

  return {
    errCode: String(
      data.err_code ?? "",
    ),

    message:
      data.msg ?? "",
  };
}

async function sendDiscord(
  env,
  content,
) {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${RESULT_CHANNEL}/messages`,
    {
      method: "POST",

      headers: {
        Authorization:
          `Bot ${env.DISCORD_BOT_TOKEN}`,

        "Content-Type":
          "application/json",
      },

      body: JSON.stringify({
        content,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Discord送信エラー: HTTP ${response.status}`,
    );
  }
}

function pageMessage(
  title,
  message,
  ok,
) {
  return new Response(
    `<!doctype html>
<html lang="ja">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
<style>${PAGE_STYLE}</style>

<body>
  <main>
    <div class="mark">
      ${ok ? "✓" : "!"}
    </div>

    <h1>${title}</h1>

    <p>${message}</p>

    <a href="/">
      登録画面へ戻る
    </a>
  </main>
</body>
</html>`,

    {
      status:
        ok ? 200 : 400,

      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",
      },
    },
  );
}

function escapeHtml(value) {
  return value.replace(
    /[&<>"']/g,

    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

const PAGE_STYLE = `
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #071426;
  color: #f7fbff;
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 22px;
}

main {
  width: min(100%, 440px);
  background:
    linear-gradient(
      145deg,
      #102746,
      #0b1c33
    );
  border: 1px solid #27466e;
  border-radius: 26px;
  padding: 30px;
  box-shadow:
    0 24px 70px #0008;
}

h1 {
  margin: 8px 0 12px;
  font-size: 28px;
}

p {
  color: #b9c9dc;
  line-height: 1.7;
}

.logo,
.mark {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  border-radius: 18px;
  background: #ffb229;
  color: #111;
  font-size: 30px;
  font-weight: 800;
}

label {
  display: block;
  margin: 18px 0 7px;
  color: #d9e6f4;
  font-weight: 700;
}

input {
  width: 100%;
  border:
    1px solid #36567d;
  background: #07172b;
  color: white;
  border-radius: 13px;
  padding: 15px;
  font-size: 17px;
  outline: none;
}

input:focus {
  border-color: #ffb229;
  box-shadow:
    0 0 0 3px #ffb22922;
}

button,
a {
  display: block;
  width: 100%;
  margin-top: 24px;
  border: 0;
  border-radius: 14px;
  padding: 16px;
  background: #ffb229;
  color: #15100a;
  text-align: center;
  text-decoration: none;
  font-size: 17px;
  font-weight: 800;
}

.note {
  font-size: 13px;
  color: #849ab3;
  margin-top: 16px;
}
`;

const REGISTRATION_PAGE = `
<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >

  <title>
    ホワサバ ギフトコード自動受取
  </title>

  <style>
    ${PAGE_STYLE}
  </style>
</head>

<body>
  <main>
    <div class="logo">
      🎁
    </div>

    <h1>
      ギフトコード自動受取
    </h1>

    <p>
      一度登録すると、
      新しいギフトコードを検知した際に
      自動で交換します。
    </p>

    <form
      method="post"
      action="/register"
    >
      <label>
        ゲーム内の名前
      </label>

      <input
        name="player_name"
        maxlength="30"
        required
        placeholder="例：シュガー"
      >

      <label>
        プレイヤーID
      </label>

      <input
        name="player_id"
        inputmode="numeric"
        pattern="[0-9]*"
        required
        placeholder="例：441788306"
      >

      <label>
        王国番号
      </label>

      <input
        name="kingdom_id"
        inputmode="numeric"
        pattern="[0-9]*"
        required
        placeholder="例：3338"
      >

      <button type="submit">
        自動受取に登録する
      </button>
    </form>

    <div class="note">
      ゲームのログイン情報は不要です。
      同じIDと王国番号は
      重複登録されません。
    </div>
  </main>
</body>
</html>
`;

function md5(input) {
  const add = (a, b) =>
    (a + b) & 0xffffffff;

  const cmn = (
    q,
    a,
    b,
    x,
    s,
    t,
  ) => {
    const n = add(
      add(a, q),
      add(x, t),
    );

    return add(
      (n << s) |
        (n >>> (32 - s)),
      b,
    );
  };

  const ff = (
    a,
    b,
    c,
    d,
    x,
    s,
    t,
  ) =>
    cmn(
      (b & c) | (~b & d),
      a,
      b,
      x,
      s,
      t,
    );

  const gg = (
    a,
    b,
    c,
    d,
    x,
    s,
    t,
  ) =>
    cmn(
      (b & d) | (c & ~d),
      a,
      b,
      x,
      s,
      t,
    );

  const hh = (
    a,
    b,
    c,
    d,
    x,
    s,
    t,
  ) =>
    cmn(
      b ^ c ^ d,
      a,
      b,
      x,
      s,
      t,
    );

  const ii = (
    a,
    b,
    c,
    d,
    x,
    s,
    t,
  ) =>
    cmn(
      c ^ (b | ~d),
      a,
      b,
      x,
      s,
      t,
    );

  const bytes =
    new TextEncoder().encode(input);

  const len = bytes.length;

  const total =
    (((len + 8) >>> 6) + 1) *
    16;

  const x =
    new Array(total).fill(0);

  for (
    let i = 0;
    i < len;
    i++
  ) {
    x[i >> 2] |=
      bytes[i] <<
      ((i % 4) * 8);
  }

  x[len >> 2] |=
    0x80 <<
    ((len % 4) * 8);

  x[total - 2] =
    len * 8;

  let A = 1732584193;
  let B = -271733879;
  let C = -1732584194;
  let D = 271733878;

  for (
    let j = 0;
    j < x.length;
    j += 16
  ) {
    let a = A;
    let b = B;
    let c = C;
    let d = D;

    a=ff(a,b,c,d,x[j],7,-680876936);
    d=ff(d,a,b,c,x[j+1],12,-389564586);
    c=ff(c,d,a,b,x[j+2],17,606105819);
    b=ff(b,c,d,a,x[j+3],22,-1044525330);

    a=ff(a,b,c,d,x[j+4],7,-176418897);
    d=ff(d,a,b,c,x[j+5],12,1200080426);
    c=ff(c,d,a,b,x[j+6],17,-1473231341);
    b=ff(b,c,d,a,x[j+7],22,-45705983);

    a=ff(a,b,c,d,x[j+8],7,1770035416);
    d=ff(d,a,b,c,x[j+9],12,-1958414417);
    c=ff(c,d,a,b,x[j+10],17,-42063);
    b=ff(b,c,d,a,x[j+11],22,-1990404162);

    a=ff(a,b,c,d,x[j+12],7,1804603682);
    d=ff(d,a,b,c,x[j+13],12,-40341101);
    c=ff(c,d,a,b,x[j+14],17,-1502002290);
    b=ff(b,c,d,a,x[j+15],22,1236535329);

    a=gg(a,b,c,d,x[j+1],5,-165796510);
    d=gg(d,a,b,c,x[j+6],9,-1069501632);
    c=gg(c,d,a,b,x[j+11],14,643717713);
    b=gg(b,c,d,a,x[j],20,-373897302);

    a=gg(a,b,c,d,x[j+5],5,-701558691);
    d=gg(d,a,b,c,x[j+10],9,38016083);
    c=gg(c,d,a,b,x[j+15],14,-660478335);
    b=gg(b,c,d,a,x[j+4],20,-405537848);

    a=gg(a,b,c,d,x[j+9],5,568446438);
    d=gg(d,a,b,c,x[j+14],9,-1019803690);
    c=gg(c,d,a,b,x[j+3],14,-187363961);
    b=gg(b,c,d,a,x[j+8],20,1163531501);

    a=gg(a,b,c,d,x[j+13],5,-1444681467);
    d=gg(d,a,b,c,x[j+2],9,-51403784);
    c=gg(c,d,a,b,x[j+7],14,1735328473);
    b=gg(b,c,d,a,x[j+12],20,-1926607734);

    a=hh(a,b,c,d,x[j+5],4,-378558);
    d=hh(d,a,b,c,x[j+8],11,-2022574463);
    c=hh(c,d,a,b,x[j+11],16,1839030562);
    b=hh(b,c,d,a,x[j+14],23,-35309556);

    a=hh(a,b,c,d,x[j+1],4,-1530992060);
    d=hh(d,a,b,c,x[j+4],11,1272893353);
    c=hh(c,d,a,b,x[j+7],16,-155497632);
    b=hh(b,c,d,a,x[j+10],23,-1094730640);

    a=hh(a,b,c,d,x[j+13],4,681279174);
    d=hh(d,a,b,c,x[j],11,-358537222);
    c=hh(c,d,a,b,x[j+3],16,-722521979);
    b=hh(b,c,d,a,x[j+6],23,76029189);

    a=hh(a,b,c,d,x[j+9],4,-640364487);
    d=hh(d,a,b,c,x[j+12],11,-421815835);
    c=hh(c,d,a,b,x[j+15],16,530742520);
    b=hh(b,c,d,a,x[j+2],23,-995338651);

    a=ii(a,b,c,d,x[j],6,-198630844);
    d=ii(d,a,b,c,x[j+7],10,1126891415);
    c=ii(c,d,a,b,x[j+14],15,-1416354905);
    b=ii(b,c,d,a,x[j+5],21,-57434055);

    a=ii(a,b,c,d,x[j+12],6,1700485571);
    d=ii(d,a,b,c,x[j+3],10,-1894986606);
    c=ii(c,d,a,b,x[j+10],15,-1051523);
    b=ii(b,c,d,a,x[j+1],21,-2054922799);

    a=ii(a,b,c,d,x[j+8],6,1873313359);
    d=ii(d,a,b,c,x[j+15],10,-30611744);
    c=ii(c,d,a,b,x[j+6],15,-1560198380);
    b=ii(b,c,d,a,x[j+13],21,1309151649);

    a=ii(a,b,c,d,x[j+4],6,-145523070);
    d=ii(d,a,b,c,x[j+11],10,-1120210379);
    c=ii(c,d,a,b,x[j+2],15,718787259);
    b=ii(b,c,d,a,x[j+9],21,-343485551);

    A = add(A, a);
    B = add(B, b);
    C = add(C, c);
    D = add(D, d);
  }

  return [A, B, C, D]
    .map((n) =>
      [0, 8, 16, 24]
        .map((s) =>
          ((n >>> s) & 255)
            .toString(16)
            .padStart(2, "0"),
        )
        .join(""),
    )
    .join("");
}
