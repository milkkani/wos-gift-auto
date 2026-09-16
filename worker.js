const SOURCE_CHANNEL = "1542165450207527094";
const RESULT_CHANNEL = "1542167671154409563";

const WOS_API =
  "https://wos-giftcode-api.centurygame.com/api/gift_code";

const WOS_KEY = "tB87#kPtkxqOS2";

/*
 * 1回のCronで処理する最大人数。
 *
 * Cloudflare Freeプランの制限に余裕を持たせるため、
 * 一度に全員を無理に処理せず、
 * 残った人は次の毎分Cronで処理する。
 */
const MAX_MEMBERS_PER_RUN = 10;

/*
 * 1人あたりの通信タイムアウト
 */
const REDEEM_TIMEOUT_MS = 12000;


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
          "Content-Type":
            "text/html; charset=UTF-8",
        },
      });
    }

    return new Response("Not Found", {
      status: 404,
    });
  },


  async scheduled(_controller, env, ctx) {
    /*
     * Cronの処理をCloudflareに待ってもらう。
     */
    ctx.waitUntil(
      runScheduled(env).catch((error) => {
        console.error(
          "scheduled error:",
          error,
        );
      }),
    );
  },
};


/* =========================================================
   Cron
========================================================= */

async function runScheduled(env) {
  await ensureDatabase(env);

  try {
    await checkDiscord(env);
  } catch (error) {
    console.error(
      "checkDiscord error:",
      error,
    );
  }
}


/* =========================================================
   Database
========================================================= */

async function ensureDatabase(env) {
  if (!env.MEMBERS_DB) {
    throw new Error(
      "MEMBERS_DB が未設定です",
    );
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
    `),    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS code_jobs (
        code TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        notified INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER NOT NULL DEFAULT 0
      )
    `),
  ]);

  /*
   * 管理者アカウント
   */
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


/* =========================================================
   登録
========================================================= */

async function registerMember(
  request,
  env,
) {
  const form =
    await request.formData();

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


  if (
    Number(count?.total || 0) >= 500
  ) {
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

    if (
      String(error).includes(
        "UNIQUE",
      )
    ) {
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

    `${escapeHtml(
      playerName,
    )}さんを王国${escapeHtml(
      kingdomId,
    )}で登録しました。次回から新しいギフトコードを自動受取します。`,

    true,
  );
}


/* =========================================================
   Discordからコード取得
========================================================= */

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
          "WOSGiftAuto (Cloudflare Workers, 3.0)",
      },
    },
  );


  if (!response.ok) {
    throw new Error(
      `Discord読取エラー: HTTP ${response.status}`,
    );
  }


  const messages =
    await response.json();

  const codes = new Set();


  /*
   * 古いメッセージ → 新しいメッセージ
   */
  for (
    const message of
      [...messages].reverse()
  ) {

    const text = [
      message.content || "",

      ...(message.embeds || [])
        .flatMap(
          (embed) => [
            embed.title || "",
            embed.description || "",

            ...(embed.fields || [])
              .map(
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


  /*
   * コードを順番に処理
   */

    /*
   * Discordで見つけたコードをD1へ保存。
   * ここでは交換処理はまだ行わない。
   */

  for (const code of codes) {
  await env.MEMBERS_DB.prepare(`
    INSERT OR IGNORE INTO code_jobs (
      code,
      notified
    )
    VALUES (
      ?,
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM processed_codes
          WHERE code = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM members m
          LEFT JOIN processed_codes p
            ON p.member_id = m.id
            AND p.code = ?
          WHERE m.active = 1
            AND p.member_id IS NULL
        )
        THEN 1
        ELSE 0
      END
    )
  `)
    .bind(
      code,
      code,
      code,
    )
    .run();
}

  /*
   * D1に残っている未完了コードを処理する。
   * Discordの直近20件から消えても処理を継続できる。
   */
  const { results: jobs = [] } =
    await env.MEMBERS_DB.prepare(`
      SELECT code
      FROM code_jobs
      WHERE notified = 0
      ORDER BY created_at ASC
      LIMIT 10
    `)
      .all();

  for (const job of jobs) {
    try {
      await processCodeForMembers(
        job.code,
        env,
      );
    } catch (error) {
      console.error(
        `code ${job.code} error:`,
        error,
      );
    }
  }
}


/* =========================================================
   コードを登録者へ配布
========================================================= */

async function processCodeForMembers(
  code,
  env,
) {
  const now = Math.floor(Date.now() / 1000);
  const lockUntil = now + 180;

  /*
   * このコードの処理権を取得。
   * 別のCronが処理中なら触らない。
   */
  const lockResult =
    await env.MEMBERS_DB.prepare(`
      UPDATE code_jobs
      SET locked_until = ?
      WHERE code = ?
        AND notified = 0
        AND locked_until < ?
    `)
      .bind(
        lockUntil,
        code,
        now,
      )
      .run();

  const changed =
    Number(
      lockResult?.meta?.changes ??
      lockResult?.changes ??
      0,
    );

  if (changed === 0) {
    console.log(
      `code ${code}: locked or already notified`,
    );
    return;
  }

  try {
    /*
     * まだ処理が完了していない人を
     * 最大10人だけ取得。
     */
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
        LIMIT ?
      `)
        .bind(
          code,
          MAX_MEMBERS_PER_RUN,
        )
        .all();

    /*
     * DBへ保存する最終結果。
     * ここに無い結果は一時的なものとして
     * 次回Cronで再試行する。
     */
    const finalCodes = new Set([
      "20000",
      "40005",
      "40006",
      "40007",
      "40008",
      "40010",
      "40011",
      "40014",
      "40020",
    ]);

    for (const member of members) {
      try {
        const result = await redeem(
          code,
          member.player_id,
          member.kingdom_id,
        );

        console.log(
          "redeem result:",
          {
            code,
            player: member.player_id,
            errCode: result.errCode,
            message: result.message,
          },
        );

        /*
         * 未知・一時的な結果は保存しない。
         * 次回Cronで再試行。
         */
        if (
          !finalCodes.has(
            result.errCode,
          )
        ) {
          console.log(
            `retry later: code=${code} player=${member.player_id} err=${result.errCode}`,
          );
          continue;
        }

        /*
         * 最終結果だけ保存。
         */
        await env.MEMBERS_DB.prepare(`
          INSERT OR REPLACE INTO processed_codes
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

      } catch (error) {
        /*
         * 1人失敗しても残りの人は続ける。
         * DBへ保存しないので次回再試行される。
         */
        console.error(
          `redeem error: code=${code} name=${member.player_name} player=${member.player_id}`,
          error,
        );
      }
    }

    /*
     * 全登録者のうち、
     * まだ最終結果が保存されていない人数。
     */
    const remainingRow =
      await env.MEMBERS_DB.prepare(`
        SELECT COUNT(*) AS total
        FROM members m
        LEFT JOIN processed_codes p
          ON p.member_id = m.id
          AND p.code = ?
        WHERE m.active = 1
          AND p.member_id IS NULL
      `)
        .bind(code)
        .first();

    const remaining =
      Number(
        remainingRow?.total || 0,
      );

    console.log(
      `code ${code}: remaining=${remaining}`,
    );

    /*
     * まだ残っていれば通知しない。
     * 次の毎分Cronへ。
     */
    if (remaining > 0) {
      return;
    }

    /*
     * 全員完了。
     * 今までの全結果をDBから集計する。
     */
    const totals =
      await env.MEMBERS_DB.prepare(`
        SELECT
          SUM(
            CASE
              WHEN p.err_code = '20000'
              THEN 1
              ELSE 0
            END
          ) AS success,

          SUM(
            CASE
              WHEN p.err_code IN (
                '40008',
                '40011'
              )
              THEN 1
              ELSE 0
            END
          ) AS already,

          SUM(
            CASE
              WHEN p.err_code NOT IN (
                '20000',
                '40008',
                '40011'
              )
              THEN 1
              ELSE 0
            END
          ) AS failed

        FROM members m
        JOIN processed_codes p
          ON p.member_id = m.id
          AND p.code = ?

        WHERE m.active = 1
      `)
        .bind(code)
        .first();

    const success =
      Number(totals?.success || 0);

    const already =
      Number(totals?.already || 0);

    const failed =
      Number(totals?.failed || 0);

    /*
     * Discord通知済みか再確認。
     */
    const job =
      await env.MEMBERS_DB.prepare(`
        SELECT notified
        FROM code_jobs
        WHERE code = ?
      `)
        .bind(code)
        .first();

    if (
      Number(job?.notified || 0) === 1
    ) {
      return;
    }

    /*
     * 全員完了後に1回だけ通知。
     */
    await sendDiscord(
      env,
      `🎁 **ギフトコード自動交換結果**
コード：\`${code}\`
✅ 受取成功：${success}人
☑️ 受取済み：${already}人
⚠️ その他：${failed}人
🏁 全登録者の処理完了`,
    );

    /*
     * Discord送信成功後にだけ
     * notified = 1 にする。
     *
     * Discord送信に失敗した場合は
     * ここまで来ないので、
     * 次回Cronで通知を再試行できる。
     */
    await env.MEMBERS_DB.prepare(`
      UPDATE code_jobs
      SET notified = 1
      WHERE code = ?
    `)
      .bind(code)
      .run();

    console.log(
      `code ${code}: completed and notified`,
    );

  } finally {
    /*
     * 成功・失敗に関係なくロック解除。
     */
    await env.MEMBERS_DB.prepare(`
      UPDATE code_jobs
      SET locked_until = 0
      WHERE code = ?
    `)
      .bind(code)
      .run();
  }
}

/* =========================================================
   ホワサバAPI
========================================================= */

async function redeem(
  code,
  playerId,
  kingdomId,
) {

  const time =
    Math.floor(
      Date.now() / 1000,
    ).toString();


  const sign = md5(
    `cdk=${code}&fid=${playerId}&kid=${kingdomId}&time=${time}${WOS_KEY}`,
  );


  const body =
    new URLSearchParams({
      cdk: code,
      fid: playerId,
      kid: kingdomId,
      time,
      sign,
    });


  /*
   * タイムアウト用
   */
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      REDEEM_TIMEOUT_MS,
    );


  let response;


  try {

    response =
      await fetch(
        WOS_API,
        {
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

          body:
            body.toString(),

          signal:
            controller.signal,
        },
      );

  } finally {

    clearTimeout(timer);
  }


  if (!response.ok) {

    throw new Error(
      `ホワサバAPIエラー: HTTP ${response.status}`,
    );
  }


  let data;


  try {

    data =
      await response.json();

  } catch (error) {

    throw new Error(
      "ホワサバAPIからJSON以外の応答が返りました",
    );
  }


  return {
    errCode:
      String(
        data.err_code ?? "",
      ),

    message:
      String(
        data.msg ?? "",
      ),
  };
}


/* =========================================================
   Discord送信
========================================================= */

async function sendDiscord(
  env,
  content,
) {

  const response =
    await fetch(
      `https://discord.com/api/v10/channels/${RESULT_CHANNEL}/messages`,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bot ${env.DISCORD_BOT_TOKEN}`,

          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            content,
          }),
      },
    );


  if (!response.ok) {

    const text =
      await response.text();

    throw new Error(
      `Discord送信エラー: HTTP ${response.status} ${text}`,
    );
  }
}


/* =========================================================
   登録完了ページ
========================================================= */

function pageMessage(
  title,
  message,
  ok,
) {

  return new Response(
    `<!doctype html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
${title}
</title>

<style>
${PAGE_STYLE}
</style>

</head>


<body>

<main>

<div class="mark">
${ok ? "✓" : "!"}
</div>

<h1>
${title}
</h1>

<p>
${message}
</p>

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


/* =========================================================
   HTML escape
========================================================= */

function escapeHtml(value) {

  return String(value).replace(
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


/* =========================================================
   登録ページ
========================================================= */

const PAGE_STYLE = `
* {
  box-sizing: border-box;
}

body {
  margin: 0;

  background:
    #071426;

  color:
    #f7fbff;

  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  min-height:
    100vh;

  display:
    grid;

  place-items:
    center;

  padding:
    22px;
}


main {
  width:
    min(100%, 440px);

  background:
    linear-gradient(
      145deg,
      #102746,
      #0b1c33
    );

  border:
    1px solid #27466e;

  border-radius:
    26px;

  padding:
    30px;

  box-shadow:
    0 24px 70px #0008;
}


h1 {
  margin:
    8px 0 12px;

  font-size:
    28px;
}


p {
  color:
    #b9c9dc;

  line-height:
    1.7;
}


.logo,
.mark {
  width:
    58px;

  height:
    58px;

  display:
    grid;

  place-items:
    center;

  border-radius:
    18px;

  background:
    #ffb229;

  color:
    #111;

  font-size:
    30px;

  font-weight:
    800;
}


label {
  display:
    block;

  margin:
    18px 0 7px;

  color:
    #d9e6f4;

  font-weight:
    700;
}


input {
  width:
    100%;

  border:
    1px solid #36567d;

  background:
    #07172b;

  color:
    white;

  border-radius:
    13px;

  padding:
    15px;

  font-size:
    17px;

  outline:
    none;
}


input:focus {
  border-color:
    #ffb229;

  box-shadow:
    0 0 0 3px #ffb22922;
}


button {
  width:
    100%;

  margin-top:
    24px;

  border:
    0;

  border-radius:
    14px;

  padding:
    16px;

  background:
    #ffb229;

  color:
    #111;

  font-size:
    17px;

  font-weight:
    800;

  cursor:
    pointer;
}


button:active {
  transform:
    scale(0.98);
}


a {
  display:
    inline-block;

  margin-top:
    20px;

  color:
    #ffbd48;

  text-decoration:
    none;

  font-weight:
    700;
}


small {
  display:
    block;

  margin-top:
    8px;

  color:
    #7890aa;

  line-height:
    1.5;
}
`;


/* =========================================================
   登録フォームHTML
========================================================= */

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
プレイヤー情報を登録すると、
新しいギフトコードを検知した際に
自動で受取処理を行います。
</p>


<form
  method="POST"
  action="/register"
>


<label>
プレイヤー名
</label>

<input
  type="text"
  name="player_name"
  maxlength="30"
  placeholder="ゲーム内の名前"
  required
>


<label>
プレイヤーID
</label>

<input
  type="text"
  name="player_id"
  inputmode="numeric"
  pattern="[0-9]*"
  placeholder="例：441788306"
  required
>


<label>
王国番号
</label>

<input
  type="text"
  name="kingdom_id"
  inputmode="numeric"
  pattern="[0-9]*"
  placeholder="例：3338"
  required
>


<button type="submit">
登録する
</button>


<small>
登録済みのプレイヤーは、
同じプレイヤーID・王国番号で
重複登録されません。
</small>


</form>

</main>

</body>

</html>
`;


/* =========================================================
   MD5
========================================================= */

/*
 * 外部ライブラリなしで動くMD5
 */
function md5(string) {

  function rotateLeft(
    value,
    shift,
  ) {
    return (
      (value << shift) |
      (value >>> (32 - shift))
    );
  }


  function addUnsigned(
    x,
    y,
  ) {

    const x4 =
      x & 0x40000000;

    const y4 =
      y & 0x40000000;

    const x8 =
      x & 0x80000000;

    const y8 =
      y & 0x80000000;

    const result =
      (x & 0x3fffffff) +
      (y & 0x3fffffff);


    if (x4 & y4) {
      return (
        result ^
        0x80000000 ^
        x8 ^
        y8
      );
    }


    if (x4 | y4) {

      if (
        result &
        0x40000000
      ) {
        return (
          result ^
          0xc0000000 ^
          x8 ^
          y8
        );
      }

      return (
        result ^
        0x40000000 ^
        x8 ^
        y8
      );
    }


    return (
      result ^
      x8 ^
      y8
    );
  }


  function F(
    x,
    y,
    z,
  ) {
    return (
      (x & y) |
      (~x & z)
    );
  }


  function G(
    x,
    y,
    z,
  ) {
    return (
      (x & z) |
      (y & ~z)
    );
  }


  function H(
    x,
    y,
    z,
  ) {
    return (
      x ^ y ^ z
    );
  }


  function I(
    x,
    y,
    z,
  ) {
    return (
      y ^
      (x | ~z)
    );
  }


  function FF(
    a,
    b,
    c,
    d,
    x,
    s,
    ac,
  ) {

    a =
      addUnsigned(
        a,
        addUnsigned(
          addUnsigned(
            F(b, c, d),
            x,
          ),
          ac,
        ),
      );

    return addUnsigned(
      rotateLeft(a, s),
      b,
    );
  }


  function GG(
    a,
    b,
    c,
    d,
    x,
    s,
    ac,
  ) {

    a =
      addUnsigned(
        a,
        addUnsigned(
          addUnsigned(
            G(b, c, d),
            x,
          ),
          ac,
        ),
      );

    return addUnsigned(
      rotateLeft(a, s),
      b,
    );
  }


  function HH(
    a,
    b,
    c,
    d,
    x,
    s,
    ac,
  ) {

    a =
      addUnsigned(
        a,
        addUnsigned(
          addUnsigned(
            H(b, c, d),
            x,
          ),
          ac,
        ),
      );

    return addUnsigned(
      rotateLeft(a, s),
      b,
    );
  }


  function II(
    a,
    b,
    c,
    d,
    x,
    s,
    ac,
  ) {

    a =
      addUnsigned(
        a,
        addUnsigned(
          addUnsigned(
            I(b, c, d),
            x,
          ),
          ac,
        ),
      );

    return addUnsigned(
      rotateLeft(a, s),
      b,
    );
  }


  function convertToWordArray(
    str,
  ) {

    const length =
      str.length;

    const numberOfWordsTemp1 =
      length + 8;

    const numberOfWordsTemp2 =
      (
        numberOfWordsTemp1 -
        (numberOfWordsTemp1 % 64)
      ) / 64;

    const numberOfWords =
      (numberOfWordsTemp2 + 1) *
      16;

    const wordArray =
      new Array(
        numberOfWords - 1,
      );

    let bytePosition = 0;
    let byteCount = 0;


    while (
      byteCount < length
    ) {

      const wordCount =
        (
          byteCount -
          (byteCount % 4)
        ) / 4;

      bytePosition =
        (byteCount % 4) * 8;

      wordArray[wordCount] =
        (
          wordArray[wordCount] ||
          0
        ) |
        (
          str.charCodeAt(
            byteCount,
          ) <<
          bytePosition
        );

      byteCount++;
    }


    const wordCount =
      (
        byteCount -
        (byteCount % 4)
      ) / 4;

    bytePosition =
      (byteCount % 4) * 8;


    wordArray[wordCount] =
      (
        wordArray[wordCount] ||
        0
      ) |
      (0x80 << bytePosition);


    wordArray[
      numberOfWords - 2
    ] =
      length << 3;

    wordArray[
      numberOfWords - 1
    ] =
      length >>> 29;


    return wordArray;
  }


  function wordToHex(value) {

    let result = "";

    for (
      let count = 0;
      count <= 3;
      count++
    ) {

      const byte =
        (
          value >>>
          (count * 8)
        ) &
        255;

      result +=
        (
          "0" +
          byte.toString(16)
        ).slice(-2);
    }

    return result;
  }


  function utf8Encode(str) {

    return unescape(
      encodeURIComponent(str),
    );
  }


  const x =
    convertToWordArray(
      utf8Encode(string),
    );


  let a =
    0x67452301;

  let b =
    0xefcdab89;

  let c =
    0x98badcfe;

  let d =
    0x10325476;


  const S11 = 7;
  const S12 = 12;
  const S13 = 17;
  const S14 = 22;

  const S21 = 5;
  const S22 = 9;
  const S23 = 14;
  const S24 = 20;

  const S31 = 4;
  const S32 = 11;
  const S33 = 16;
  const S34 = 23;

  const S41 = 6;
  const S42 = 10;
  const S43 = 15;
  const S44 = 21;


  for (
    let k = 0;
    k < x.length;
    k += 16
  ) {

    const AA = a;
    const BB = b;
    const CC = c;
    const DD = d;


    a = FF(a,b,c,d,x[k+0],S11,0xd76aa478);
    d = FF(d,a,b,c,x[k+1],S12,0xe8c7b756);
    c = FF(c,d,a,b,x[k+2],S13,0x242070db);
    b = FF(b,c,d,a,x[k+3],S14,0xc1bdceee);

    a = FF(a,b,c,d,x[k+4],S11,0xf57c0faf);
    d = FF(d,a,b,c,x[k+5],S12,0x4787c62a);
    c = FF(c,d,a,b,x[k+6],S13,0xa8304613);
    b = FF(b,c,d,a,x[k+7],S14,0xfd469501);

    a = FF(a,b,c,d,x[k+8],S11,0x698098d8);
    d = FF(d,a,b,c,x[k+9],S12,0x8b44f7af);
    c = FF(c,d,a,b,x[k+10],S13,0xffff5bb1);
    b = FF(b,c,d,a,x[k+11],S14,0x895cd7be);

    a = FF(a,b,c,d,x[k+12],S11,0x6b901122);
    d = FF(d,a,b,c,x[k+13],S12,0xfd987193);
    c = FF(c,d,a,b,x[k+14],S13,0xa679438e);
    b = FF(b,c,d,a,x[k+15],S14,0x49b40821);


    a = GG(a,b,c,d,x[k+1],S21,0xf61e2562);
    d = GG(d,a,b,c,x[k+6],S22,0xc040b340);
    c = GG(c,d,a,b,x[k+11],S23,0x265e5a51);
    b = GG(b,c,d,a,x[k+0],S24,0xe9b6c7aa);

    a = GG(a,b,c,d,x[k+5],S21,0xd62f105d);
    d = GG(d,a,b,c,x[k+10],S22,0x02441453);
    c = GG(c,d,a,b,x[k+15],S23,0xd8a1e681);
    b = GG(b,c,d,a,x[k+4],S24,0xe7d3fbc8);

    a = GG(a,b,c,d,x[k+9],S21,0x21e1cde6);
    d = GG(d,a,b,c,x[k+14],S22,0xc33707d6);
    c = GG(c,d,a,b,x[k+3],S23,0xf4d50d87);
    b = GG(b,c,d,a,x[k+8],S24,0x455a14ed);

    a = GG(a,b,c,d,x[k+13],S21,0xa9e3e905);
    d = GG(d,a,b,c,x[k+2],S22,0xfcefa3f8);
    c = GG(c,d,a,b,x[k+7],S23,0x676f02d9);
    b = GG(b,c,d,a,x[k+12],S24,0x8d2a4c8a);


    a = HH(a,b,c,d,x[k+5],S31,0xfffa3942);
    d = HH(d,a,b,c,x[k+8],S32,0x8771f681);
    c = HH(c,d,a,b,x[k+11],S33,0x6d9d6122);
    b = HH(b,c,d,a,x[k+14],S34,0xfde5380c);

    a = HH(a,b,c,d,x[k+1],S31,0xa4beea44);
    d = HH(d,a,b,c,x[k+4],S32,0x4bdecfa9);
    c = HH(c,d,a,b,x[k+7],S33,0xf6bb4b60);
    b = HH(b,c,d,a,x[k+10],S34,0xbebfbc70);

    a = HH(a,b,c,d,x[k+13],S31,0x289b7ec6);
    d = HH(d,a,b,c,x[k+0],S32,0xeaa127fa);
    c = HH(c,d,a,b,x[k+3],S33,0xd4ef3085);
    b = HH(b,c,d,a,x[k+6],S34,0x04881d05);

    a = HH(a,b,c,d,x[k+9],S31,0xd9d4d039);
    d = HH(d,a,b,c,x[k+12],S32,0xe6db99e5);
    c = HH(c,d,a,b,x[k+15],S33,0x1fa27cf8);
    b = HH(b,c,d,a,x[k+2],S34,0xc4ac5665);


    a = II(a,b,c,d,x[k+0],S41,0xf4292244);
    d = II(d,a,b,c,x[k+7],S42,0x432aff97);
    c = II(c,d,a,b,x[k+14],S43,0xab9423a7);
    b = II(b,c,d,a,x[k+5],S44,0xfc93a039);

    a = II(a,b,c,d,x[k+12],S41,0x655b59c3);
    d = II(d,a,b,c,x[k+3],S42,0x8f0ccc92);
    c = II(c,d,a,b,x[k+10],S43,0xffeff47d);
    b = II(b,c,d,a,x[k+1],S44,0x85845dd1);

    a = II(a,b,c,d,x[k+8],S41,0x6fa87e4f);
    d = II(d,a,b,c,x[k+15],S42,0xfe2ce6e0);
    c = II(c,d,a,b,x[k+6],S43,0xa3014314);
    b = II(b,c,d,a,x[k+13],S44,0x4e0811a1);

    a = II(a,b,c,d,x[k+4],S41,0xf7537e82);
    d = II(d,a,b,c,x[k+11],S42,0xbd3af235);
    c = II(c,d,a,b,x[k+2],S43,0x2ad7d2bb);
    b = II(b,c,d,a,x[k+9],S44,0xeb86d391);


    a =
      addUnsigned(
        a,
        AA,
      );

    b =
      addUnsigned(
        b,
        BB,
      );

    c =
      addUnsigned(
        c,
        CC,
      );

    d =
      addUnsigned(
        d,
        DD,
      );
  }


  return (
    wordToHex(a) +
    wordToHex(b) +
    wordToHex(c) +
    wordToHex(d)
  ).toLowerCase();
}
