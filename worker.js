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

   
