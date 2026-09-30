const SOURCE_CHANNEL = "1542165450207527094";
const RESULT_CHANNEL = "1542167671154409563";

/*
 * 登録情報の変更申請を送るDiscordチャンネル
 */
const CHANGE_REQUEST_CHANNEL = "1552354610021408768";


/*
 * WOS Rewards
 *
 * Discordとは別のギフトコード取得元。
 * Active Codesだけを取得する。
 */
const WOS_REWARDS_URL =
  "https://www.wosrewards.com/giftcodes";

const WOS_REWARDS_TIMEOUT_MS = 10000;


/*
 * Whiteout Survival
 * ギフトコードAPI
 */
const WOS_API =
  "https://wos-giftcode-api.centurygame.com/api/gift_code";


/*
 * ここは今使っているWOS_KEYをそのまま入れてください。
 *
 * チャット上ではキーそのものを再掲しません。
 */
const WOS_KEY = "tB87#kPtkxqOS2";

/*
 * 1回のCronで処理する最大人数。
 */
const MAX_MEMBERS_PER_RUN = 10;


/*
 * 1人あたりの通信タイムアウト
 */
const REDEEM_TIMEOUT_MS = 12000;



export default {

  async fetch(request, env) {

    await ensureDatabase(env);

    const url =
      new URL(request.url);


    /*
     * 新規登録
     */
    if (
      request.method === "POST" &&
      url.pathname === "/register"
    ) {

      return registerMember(
        request,
        env,
      );
    }


    /*
     * 登録情報確認ページ
     */
    if (
      request.method === "GET" &&
      url.pathname === "/manage"
    ) {

      return new Response(
        MANAGE_PAGE,
        {
          headers: {
            "Content-Type":
              "text/html; charset=UTF-8",
          },
        },
      );
    }


    /*
     * 登録情報を検索
     */
    if (
      request.method === "POST" &&
      url.pathname === "/lookup-member"
    ) {

      return lookupMember(
        request,
        env,
      );
    }


    /*
     * 変更申請
     */
    if (
      request.method === "POST" &&
      url.pathname === "/change-request"
    ) {

      return createChangeRequest(
        request,
        env,
      );
    }


    /*
     * トップページ
     */
    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {

      return new Response(
        REGISTRATION_PAGE,
        {
          headers: {
            "Content-Type":
              "text/html; charset=UTF-8",
          },
        },
      );
    }


    return new Response(
      "Not Found",
      {
        status: 404,
      },
    );
  },


  async scheduled(
    _controller,
    env,
    ctx,
  ) {

    ctx.waitUntil(

      runScheduled(env)
        .catch((error) => {

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


  /*
   * =====================================================
   * 変更申請の承認・却下を確認
   * =====================================================
   *
   * ここで失敗しても、
   * ギフトコード処理は止めない。
   */
  try {

    await checkChangeRequestCommands(
      env,
    );

  } catch (error) {

    console.error(
      "checkChangeRequestCommands error:",
      error,
    );
  }


  /*
   * =====================================================
   * 今回確認できたギフトコード
   * =====================================================
   *
   * Setを使うため、
   *
   * Discord
   * WOS Rewards
   *
   * の両方に同じコードがあっても
   * 1件にまとめられる。
   */
  const codes =
    new Set();


  /*
   * =====================================================
   * Discord
   * =====================================================
   *
   * 新着コードを早く検知するために使用。
   *
   * 古い投稿に残っている期限切れコードを
   * 有効扱いし続けないよう、
   * 直近24時間の投稿だけを見る。
   */
  try {

    const discordCodes =
      await getDiscordGiftCodes(
        env,
      );


    for (
      const code of
        discordCodes
    ) {

      codes.add(code);
    }


  } catch (error) {

    console.error(
      "Discord gift code source error:",
      error,
    );
  }


  /*
   * =====================================================
   * WOS Rewards
   * =====================================================
   *
   * Active Codes欄に現在掲載されている
   * コードだけを取得する。
   *
   * Discord側が失敗していても
   * こちらは独立して動く。
   */
  try {

    const rewardsCodes =
      await getWosRewardsGiftCodes();


    for (
      const code of
        rewardsCodes
    ) {

      codes.add(code);
    }


  } catch (error) {

    console.error(
      "WOS Rewards source error:",
      error,
    );
  }


  /*
   * =====================================================
   * 検知したコードを処理
   * =====================================================
   */
  try {

    await processDetectedCodes(
      [...codes],
      env,
    );


  } catch (error) {

    console.error(
      "gift code processing error:",
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

    /*
     * 古いTriggerを削除
     */
    env.MEMBERS_DB.prepare(`
      DROP TRIGGER IF EXISTS
      reopen_recent_codes_for_new_member
    `),


    /*
     * 登録者
     */
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS members (

        id INTEGER
          PRIMARY KEY
          AUTOINCREMENT,

        player_name TEXT
          NOT NULL,

        player_id TEXT
          NOT NULL,

        kingdom_id TEXT
          NOT NULL,

        active INTEGER
          NOT NULL
          DEFAULT 1,

        created_at TEXT
          NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(
          player_id,
          kingdom_id
        )
      )
    `),


    /*
     * ギフトコード受取履歴
     */
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS processed_codes (

        code TEXT
          NOT NULL,

        member_id INTEGER
          NOT NULL,

        err_code TEXT
          NOT NULL,

        message TEXT,

        processed_at TEXT
          NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY(
          code,
          member_id
        )
      )
    `),


    /*
     * ギフトコード処理キュー
     */
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS code_jobs (

        code TEXT
          PRIMARY KEY,

        created_at TEXT
          NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        notified INTEGER
          NOT NULL
          DEFAULT 0,

        locked_until INTEGER
          NOT NULL
          DEFAULT 0,

        next_member_id INTEGER
          NOT NULL
          DEFAULT 0
      )
    `),


    /*
     * 登録情報変更申請
     */
    env.MEMBERS_DB.prepare(`
      CREATE TABLE IF NOT EXISTS change_requests (

        id INTEGER
          PRIMARY KEY
          AUTOINCREMENT,

        member_id INTEGER
          NOT NULL,

        old_player_name TEXT
          NOT NULL,

        old_player_id TEXT
          NOT NULL,

        old_kingdom_id TEXT
          NOT NULL,

        new_player_name TEXT
          NOT NULL,

        new_player_id TEXT
          NOT NULL,

        new_kingdom_id TEXT
          NOT NULL,

        status TEXT
          NOT NULL
          DEFAULT 'pending',

        discord_message_id TEXT,

        created_at TEXT
          NOT NULL
          DEFAULT CURRENT_TIMESTAMP,

        resolved_at TEXT
      )
    `),


    env.MEMBERS_DB.prepare(`
      CREATE INDEX IF NOT EXISTS
      idx_members_active_id

      ON members(
        active,
        id
      )
    `),


    env.MEMBERS_DB.prepare(`
      CREATE INDEX IF NOT EXISTS
      idx_processed_codes_member_id

      ON processed_codes(
        member_id
      )
    `),


    env.MEMBERS_DB.prepare(`
      CREATE INDEX IF NOT EXISTS
      idx_change_requests_member_status

      ON change_requests(
        member_id,
        status
      )
    `),

  ]);


  /*
   * 旧DB向け。
   * next_member_idが既にあれば
   * duplicate columnだけ無視する。
   */
  try {

    await env.MEMBERS_DB.prepare(`
      ALTER TABLE code_jobs
      ADD COLUMN next_member_id INTEGER
      NOT NULL
      DEFAULT 0
    `).run();


  } catch (error) {

    const text =
      String(error);


    if (
      !text.includes(
        "duplicate column",
      )
    ) {

      throw error;
    }
  }


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
   新規登録
========================================================= */

async function registerMember(
  request,
  env,
) {

  const form =
    await request.formData();


  const playerName =
    String(
      form.get(
        "player_name",
      ) || "",
    ).trim();


  const playerId =
    String(
      form.get(
        "player_id",
      ) || "",
    ).trim();


  const kingdomId =
    String(
      form.get(
        "kingdom_id",
      ) || "",
    ).trim();


  /*
   * 入力チェック
   */
  const validationError =
    validateMemberFields(
      playerName,
      playerId,
      kingdomId,
    );


  if (validationError) {

    return pageMessage(
      "登録できません",
      validationError,
      false,
    );
  }


  /*
   * 登録人数
   */
  const count =
    await env.MEMBERS_DB
      .prepare(`
        SELECT
          COUNT(*) AS total

        FROM members

        WHERE active = 1
      `)

      .first();


  if (
    Number(
      count?.total || 0,
    ) >= 500
  ) {

    return pageMessage(
      "登録できません",
      "登録上限に達しています。管理者へ連絡してください。",
      false,
    );
  }


  let insertedMemberId = 0;


  try {

    const inserted =
      await env.MEMBERS_DB
        .prepare(`
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


    insertedMemberId =
      Number(
        inserted?.meta
          ?.last_row_id || 0,
      );


  } catch (error) {

    if (
      String(error)
        .includes(
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


  /*
   * =====================================================
   * 新規登録者を既存コードの処理対象に戻す
   * =====================================================
   *
   * code_jobsは、
   * どのmember_idまで処理したかを
   * next_member_idで記録している。
   *
   * 新規登録されたmember_idより
   * カーソルが前にあるジョブは
   * notifiedを0へ戻す。
   *
   * 実際に次回Cronで処理されるのは、
   * その時点で
   *
   * ・直近24時間のDiscord投稿
   * ・WOS RewardsのActive Codes
   *
   * のどちらかで確認できるコードだけ。
   *
   * そのため、過去の期限切れコードを
   * 新規登録者へ再送し続けることはない。
   */
  if (
    insertedMemberId > 0
  ) {

    await env.MEMBERS_DB
      .prepare(`
        UPDATE code_jobs

        SET
          notified = 0

        WHERE
          next_member_id < ?
      `)

      .bind(
        insertedMemberId,
      )

      .run();
  }


  return pageMessage(

    "登録完了！",

    `${escapeHtml(
      playerName,
    )}さんを王国${escapeHtml(
      kingdomId,
    )}で登録しました。約1分後から現在有効なギフトコードを順番に自動受取します。`,

    true,
  );
}



/* =========================================================
   登録情報入力チェック
========================================================= */

function validateMemberFields(
  playerName,
  playerId,
  kingdomId,
) {

  if (
    playerName.length < 1 ||
    playerName.length > 30
  ) {

    return (
      "名前は1〜30文字で入力してください。"
    );
  }


  if (
    !/^\d{6,15}$/
      .test(playerId)
  ) {

    return (
      "プレイヤーIDは6〜15桁の数字で入力してください。"
    );
  }


  if (
    !/^\d{1,6}$/
      .test(kingdomId) ||
    Number(kingdomId) < 1
  ) {

    return (
      "王国番号を数字で入力してください。"
    );
  }


  return "";
}



/* =========================================================
   登録情報を検索
========================================================= */

async function lookupMember(
  request,
  env,
) {

  const form =
    await request.formData();


  const playerId =
    String(
      form.get(
        "player_id",
      ) || "",
    ).trim();


  const kingdomId =
    String(
      form.get(
        "kingdom_id",
      ) || "",
    ).trim();


  /*
   * ID + 王国番号が一致する
   * 現在有効な登録を探す
   */
  const member =
    await env.MEMBERS_DB
      .prepare(`
        SELECT
          id,
          player_name,
          player_id,
          kingdom_id

        FROM members

        WHERE
          player_id = ?
          AND kingdom_id = ?
          AND active = 1

        LIMIT 1
      `)

      .bind(
        playerId,
        kingdomId,
      )

      .first();


  if (!member) {

    return pageMessage(

      "登録が見つかりません",

      "入力したプレイヤーID・王国番号の登録は見つかりませんでした。",

      false,
    );
  }


  /*
   * 既に変更申請が出ていないか確認
   */
  const pending =
    await env.MEMBERS_DB
      .prepare(`
        SELECT id

        FROM change_requests

        WHERE
          member_id = ?
          AND status = 'pending'

        LIMIT 1
      `)

      .bind(
        member.id,
      )

      .first();


  if (pending) {

    return pageMessage(

      "変更申請中です",

      `現在、変更申請 #${pending.id} が管理者の承認待ちです。`,

      true,
    );
  }


  /*
   * 現在の登録情報を入力済みの状態で
   * 編集画面を表示
   */
  return new Response(

    editMemberPage(
      member,
    ),

    {
      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",
      },
    },
  );
}



/* =========================================================
   変更申請を作成
========================================================= */

async function createChangeRequest(
  request,
  env,
) {

  const form =
    await request.formData();


  const memberId =
    Number(
      form.get(
        "member_id",
      ),
    );


  /*
   * 検索した時点の情報。
   *
   * 途中で登録情報が変わっていないか
   * 確認するために使う。
   */
  const oldPlayerId =
    String(
      form.get(
        "old_player_id",
      ) || "",
    ).trim();


  const oldKingdomId =
    String(
      form.get(
        "old_kingdom_id",
      ) || "",
    ).trim();


  /*
   * ユーザーが変更後として入力した情報
   */
  const newPlayerName =
    String(
      form.get(
        "player_name",
      ) || "",
    ).trim();


  const newPlayerId =
    String(
      form.get(
        "player_id",
      ) || "",
    ).trim();


  const newKingdomId =
    String(
      form.get(
        "kingdom_id",
      ) || "",
    ).trim();


  const validationError =
    validateMemberFields(
      newPlayerName,
      newPlayerId,
      newKingdomId,
    );


  if (
    !Number.isInteger(memberId) ||
    memberId < 1
  ) {

    return pageMessage(

      "申請できません",

      "登録情報が正しくありません。最初からやり直してください。",

      false,
    );
  }


  if (validationError) {

    return pageMessage(

      "申請できません",

      validationError,

      false,
    );
  }


  /*
   * 現在の登録情報を取得
   */
  const member =
    await env.MEMBERS_DB
      .prepare(`
        SELECT
          id,
          player_name,
          player_id,
          kingdom_id

        FROM members

        WHERE
          id = ?
          AND player_id = ?
          AND kingdom_id = ?
          AND active = 1

        LIMIT 1
      `)

      .bind(
        memberId,
        oldPlayerId,
        oldKingdomId,
      )

      .first();


  if (!member) {

    return pageMessage(

      "申請できません",

      "登録情報が途中で変更されたか、登録が見つかりませんでした。最初からやり直してください。",

      false,
    );
  }


  /*
   * 何も変更されていない
   */
  if (
    String(
      member.player_name,
    ) === newPlayerName &&

    String(
      member.player_id,
    ) === newPlayerId &&

    String(
      member.kingdom_id,
    ) === newKingdomId
  ) {

    return pageMessage(

      "変更内容がありません",

      "現在の登録情報と同じです。変更したい項目を書き換えてください。",

      false,
    );
  }


  /*
   * 変更後のID + 王国番号が
   * 他の登録者と重複していないか確認
   */
  const duplicate =
    await env.MEMBERS_DB
      .prepare(`
        SELECT id

        FROM members

        WHERE
          player_id = ?
          AND kingdom_id = ?
          AND id <> ?
          AND active = 1

        LIMIT 1
      `)

      .bind(
        newPlayerId,
        newKingdomId,
        member.id,
      )

      .first();


  if (duplicate) {

    return pageMessage(

      "申請できません",

      "変更後のプレイヤーID・王国番号は、すでに別の登録で使用されています。",

      false,
    );
  }


  /*
   * 既に承認待ちの申請があるか確認
   */
  const existingPending =
    await env.MEMBERS_DB
      .prepare(`
        SELECT id

        FROM change_requests

        WHERE
          member_id = ?
          AND status = 'pending'

        LIMIT 1
      `)

      .bind(
        member.id,
      )

      .first();


  if (existingPending) {

    return pageMessage(

      "変更申請中です",

      `すでに変更申請 #${existingPending.id} が承認待ちです。`,

      true,
    );
  }


  /*
   * 変更申請を保存
   */
  const inserted =
    await env.MEMBERS_DB
      .prepare(`
        INSERT INTO change_requests
        (
          member_id,

          old_player_name,
          old_player_id,
          old_kingdom_id,

          new_player_name,
          new_player_id,
          new_kingdom_id
        )

        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )
      `)

      .bind(

        member.id,

        member.player_name,
        member.player_id,
        member.kingdom_id,

        newPlayerName,
        newPlayerId,
        newKingdomId,
      )

      .run();


  const requestId =
    Number(
      inserted?.meta
        ?.last_row_id || 0,
    );


  /*
   * Discordに送る申請内容
   */
  const discordText =

    `📝 **登録情報の変更申請 #${requestId}**

**変更前**
名前：${member.player_name}
王国：${member.kingdom_id}
ID：${member.player_id}

**変更後**
名前：${newPlayerName}
王国：${newKingdomId}
ID：${newPlayerId}

承認する場合：
\`承認 ${requestId}\`

却下する場合：
\`却下 ${requestId}\``;


  try {

    const discordMessage =
      await sendDiscordToChannel(

        env,

        CHANGE_REQUEST_CHANNEL,

        discordText,
      );


    /*
     * Discord側のメッセージIDも保存
     */
    if (
      discordMessage?.id
    ) {

      await env.MEMBERS_DB
        .prepare(`
          UPDATE change_requests

          SET
            discord_message_id = ?

          WHERE id = ?
        `)

        .bind(
          String(
            discordMessage.id,
          ),

          requestId,
        )

        .run();
    }


  } catch (error) {

    /*
     * Discordへ送れなかった場合は
     * DBだけに申請を残さない。
     */
    await env.MEMBERS_DB
      .prepare(`
        DELETE FROM change_requests

        WHERE
          id = ?
          AND status = 'pending'
      `)

      .bind(
        requestId,
      )

      .run();


    console.error(
      "change request discord error:",
      error,
    );


    return pageMessage(

      "申請を送れませんでした",

      "Discordへの送信に失敗しました。少し時間を置いてもう一度お試しください。",

      false,
    );
  }


  return pageMessage(

    "変更申請を送りました",

    `申請番号は #${requestId} です。管理者が承認すると登録情報が更新されます。`,

    true,
  );
}

/* =========================================================
   Discordで変更申請の承認・却下を確認
========================================================= */

async function checkChangeRequestCommands(
  env,
) {

  if (!env.DISCORD_BOT_TOKEN) {

    throw new Error(
      "DISCORD_BOT_TOKEN が未設定です",
    );
  }


  /*
   * 変更申請チャンネルの直近50件を取得
   */
  const response =
    await fetch(

      `https://discord.com/api/v10/channels/${CHANGE_REQUEST_CHANNEL}/messages?limit=50`,

      {
        headers: {

          Authorization:
            `Bot ${env.DISCORD_BOT_TOKEN}`,

          "User-Agent":
            "WOSGiftAuto (Cloudflare Workers, 4.1)",
        },
      },
    );


  if (!response.ok) {

    throw new Error(
      `変更申請チャンネル読取エラー: HTTP ${response.status}`,
    );
  }


  const messages =
    await response.json();


  /*
   * 古いメッセージから順番に確認
   */
  for (
    const message of
      [...messages].reverse()
  ) {

    /*
     * Bot自身のメッセージは無視
     */
    if (
      message.author?.bot
    ) {
      continue;
    }


    const content =
      String(
        message.content || "",
      ).trim();


    /*
     * 対応形式
     *
     * 承認 12
     * 承認12
     * 承認 #12
     *
     * 却下 12
     * 却下12
     * 却下 #12
     */
    const match =
      content.match(
        /^(承認|却下)\s*#?(\d+)$/,
      );


    if (!match) {
      continue;
    }


    const action =
      match[1];


    const requestId =
      Number(
        match[2],
      );


    /*
     * pending状態の申請だけ取得
     */
    const changeRequest =
      await env.MEMBERS_DB
        .prepare(`
          SELECT
            id,
            member_id,

            old_player_name,
            old_player_id,
            old_kingdom_id,

            new_player_name,
            new_player_id,
            new_kingdom_id,

            status

          FROM change_requests

          WHERE
            id = ?
            AND status = 'pending'

          LIMIT 1
        `)

        .bind(
          requestId,
        )

        .first();


    if (!changeRequest) {
      continue;
    }


    /*
     * =====================================================
     * 却下
     * =====================================================
     */
    if (
      action === "却下"
    ) {

      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'rejected',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      /*
       * 他のCronが先に処理した場合は
       * 二重通知しない
       */
      if (
        changed === 0
      ) {
        continue;
      }


      await sendDiscordToChannel(

        env,

        CHANGE_REQUEST_CHANNEL,

        `❌ **変更申請 #${requestId} を却下しました。**

登録情報は変更されていません。`,
      );


      continue;
    }


    /*
     * =====================================================
     * 承認
     * =====================================================
     */


    /*
     * 現在のmembers情報を取得
     */
    const currentMember =
      await env.MEMBERS_DB
        .prepare(`
          SELECT
            id,
            player_name,
            player_id,
            kingdom_id

          FROM members

          WHERE
            id = ?
            AND active = 1

          LIMIT 1
        `)

        .bind(
          changeRequest.member_id,
        )

        .first();


    /*
     * 元の登録が消えていた場合
     */
    if (!currentMember) {

      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'error',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      if (
        changed > 0
      ) {

        await sendDiscordToChannel(

          env,

          CHANGE_REQUEST_CHANNEL,

          `⚠️ **変更申請 #${requestId}**

元の登録情報が見つからなかったため、承認できませんでした。`,
        );
      }


      continue;
    }


    /*
     * 申請後に現在の登録情報が
     * 別の方法で変更されていないか確認。
     *
     * 申請時点と違っていたら
     * 古い申請で上書きしない。
     */
    if (
      String(
        currentMember.player_name,
      ) !==
        String(
          changeRequest.old_player_name,
        ) ||

      String(
        currentMember.player_id,
      ) !==
        String(
          changeRequest.old_player_id,
        ) ||

      String(
        currentMember.kingdom_id,
      ) !==
        String(
          changeRequest.old_kingdom_id,
        )
    ) {

      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'error',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      if (
        changed > 0
      ) {

        await sendDiscordToChannel(

          env,

          CHANGE_REQUEST_CHANNEL,

          `⚠️ **変更申請 #${requestId}**

申請後に登録情報が変わっていたため、自動承認を中止しました。

現在：
${currentMember.player_name}
王国${currentMember.kingdom_id}
ID ${currentMember.player_id}`,
        );
      }


      continue;
    }


    /*
     * 変更後のID + 王国番号が
     * 別の登録と重複していないか
     * 承認直前にも再確認
     */
    const duplicate =
      await env.MEMBERS_DB
        .prepare(`
          SELECT id

          FROM members

          WHERE
            player_id = ?
            AND kingdom_id = ?
            AND id <> ?
            AND active = 1

          LIMIT 1
        `)

        .bind(
          changeRequest.new_player_id,
          changeRequest.new_kingdom_id,
          changeRequest.member_id,
        )

        .first();


    if (duplicate) {

      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'error',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      if (
        changed > 0
      ) {

        await sendDiscordToChannel(

          env,

          CHANGE_REQUEST_CHANNEL,

          `⚠️ **変更申請 #${requestId}**

変更後のプレイヤーID・王国番号が、別の登録と重複しているため承認できませんでした。`,
        );
      }


      continue;
    }


    /*
     * プレイヤーIDが変わったか
     */
    const playerIdChanged =

      String(
        currentMember.player_id,
      ) !==

      String(
        changeRequest.new_player_id,
      );


    /*
     * membersの同じ1件をUPDATEする。
     *
     * INSERTではないため、
     * 名前・ID・王国番号を変更しても
     * 登録が2件になることはない。
     */
    try {

      await env.MEMBERS_DB
        .prepare(`
          UPDATE members

          SET
            player_name = ?,
            player_id = ?,
            kingdom_id = ?

          WHERE
            id = ?
            AND active = 1
        `)

        .bind(
          changeRequest.new_player_name,
          changeRequest.new_player_id,
          changeRequest.new_kingdom_id,
          changeRequest.member_id,
        )

        .run();


    } catch (error) {

      console.error(
        `change request #${requestId} member update error:`,
        error,
      );


      const result =
        await env.MEMBERS_DB
          .prepare(`
            UPDATE change_requests

            SET
              status = 'error',
              resolved_at =
                CURRENT_TIMESTAMP

            WHERE
              id = ?
              AND status = 'pending'
          `)

          .bind(
            requestId,
          )

          .run();


      const changed =
        Number(
          result?.meta?.changes ??
          result?.changes ??
          0,
        );


      if (
        changed > 0
      ) {

        await sendDiscordToChannel(

          env,

          CHANGE_REQUEST_CHANNEL,

          `⚠️ **変更申請 #${requestId}**

登録情報の更新中にエラーが発生しました。

登録情報が重複していないか確認してください。`,
        );
      }


      continue;
    }


    /*
     * =====================================================
     * プレイヤーIDを変更した場合
     * =====================================================
     *
     * 同じmember_idの過去の受取履歴を削除。
     *
     * さらにcode_jobsのカーソルを
     * このmemberより前へ戻す。
     *
     * 次回Cronで「現在有効」と確認できた
     * ギフトコードだけが
     * 新しいプレイヤーIDへ再処理される。
     */
    if (
      playerIdChanged
    ) {

      await env.MEMBERS_DB
        .prepare(`
          DELETE FROM processed_codes

          WHERE member_id = ?
        `)

        .bind(
          changeRequest.member_id,
        )

        .run();


      const restartFrom =
        Math.max(
          0,
          Number(
            changeRequest.member_id,
          ) - 1,
        );


      await env.MEMBERS_DB
        .prepare(`
          UPDATE code_jobs

          SET
            next_member_id =
              CASE

                WHEN next_member_id > ?
                  THEN ?

                ELSE next_member_id

              END,

            notified = 0
        `)

        .bind(
          restartFrom,
          restartFrom,
        )

        .run();
    }


    /*
     * 申請を承認済みにする
     */
    const approvedResult =
      await env.MEMBERS_DB
        .prepare(`
          UPDATE change_requests

          SET
            status = 'approved',
            resolved_at =
              CURRENT_TIMESTAMP

          WHERE
            id = ?
            AND status = 'pending'
        `)

        .bind(
          requestId,
        )

        .run();


    const approvedChanged =
      Number(
        approvedResult
          ?.meta
          ?.changes ??

        approvedResult
          ?.changes ??

        0,
      );


    if (
      approvedChanged === 0
    ) {

      console.log(
        `change request #${requestId}: already processed`,
      );

      continue;
    }


    /*
     * Discordに承認結果を通知
     */
    let approvedText =

      `✅ **変更申請 #${requestId} を承認しました。**

**変更前**
名前：${changeRequest.old_player_name}
王国：${changeRequest.old_kingdom_id}
ID：${changeRequest.old_player_id}

**変更後**
名前：${changeRequest.new_player_name}
王国：${changeRequest.new_kingdom_id}
ID：${changeRequest.new_player_id}

登録件数は増えず、元の登録1件が更新されています。`;


    if (
      playerIdChanged
    ) {

      approvedText += `

🔄 プレイヤーIDが変更されたため、旧IDのギフトコード受取履歴は引き継いでいません。

現在有効なコードは、新しいIDに対して順番に自動受取されます。`;


    } else {

      approvedText += `

☑️ プレイヤーIDは同じため、これまでのギフトコード受取履歴は維持されています。`;
    }


    await sendDiscordToChannel(

      env,

      CHANGE_REQUEST_CHANNEL,

      approvedText,
    );
  }
}



/* =========================================================
   Discordの指定チャンネルへ送信
========================================================= */

async function sendDiscordToChannel(
  env,
  channelId,
  content,
) {

  if (!env.DISCORD_BOT_TOKEN) {

    throw new Error(
      "DISCORD_BOT_TOKEN が未設定です",
    );
  }


  const response =
    await fetch(

      `https://discord.com/api/v10/channels/${channelId}/messages`,

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

    const responseText =
      await response.text();


    throw new Error(

      `Discord送信エラー: HTTP ${response.status} ${responseText}`,

    );
  }


  return response.json();
}

/* =========================================================
   Discordからギフトコード取得
========================================================= */

async function getDiscordGiftCodes(
  env,
) {

  if (!env.DISCORD_BOT_TOKEN) {

    throw new Error(
      "DISCORD_BOT_TOKEN が未設定です",
    );
  }


  const response =
    await fetch(

      `https://discord.com/api/v10/channels/${SOURCE_CHANNEL}/messages?limit=20`,

      {
        headers: {

          Authorization:
            `Bot ${env.DISCORD_BOT_TOKEN}`,

          "User-Agent":
            "WOSGiftAuto (Cloudflare Workers, 4.1)",
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


  const codes =
    new Set();


  /*
   * =====================================================
   * Discordは直近24時間だけ確認
   * =====================================================
   *
   * Discordは
   * 「新しいコードを早く見つける」
   * ために使用する。
   *
   * 古い投稿に期限切れコードが
   * 残っていても、
   * それを現在有効なコードとして
   * 扱い続けないようにする。
   *
   * 24時間以上経過しても
   * まだ有効なコードについては
   * WOS RewardsのActive Codes側から
   * 取得する。
   */
  const discordCutoff =

    Date.now() -

    (
      24 *
      60 *
      60 *
      1000
    );


  /*
   * 古いメッセージ
   * ↓
   * 新しいメッセージ
   */
  for (
    const message of
      [...messages].reverse()
  ) {


    /*
     * Discordメッセージの
     * 投稿日時を確認
     */
    const messageTime =
      Date.parse(
        String(
          message.timestamp || "",
        ),
      );


    /*
     * 日時が取得できない投稿、
     * または24時間より古い投稿は
     * ギフトコード検知対象にしない。
     */
    if (
      !Number.isFinite(
        messageTime,
      ) ||

      messageTime <
        discordCutoff
    ) {

      continue;
    }


    /*
     * 通常メッセージだけでなく
     * Embed内も検索する。
     */
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


    /*
     * 対応例
     *
     * Gift Code: ABC123
     * Code: ABC123
     * code：ABC123
     */
    for (
      const match of
        text.matchAll(

          /(?:gift\s*code|code)\s*[:：]\s*([A-Za-z0-9_-]{4,64})/gi,

        )
    ) {

      const code =
        cleanGiftCode(
          match[1],
        );


      if (
        isValidGiftCode(
          code,
        )
      ) {

        codes.add(
          code,
        );
      }
    }
  }


  console.log(
    "Discord gift codes:",
    [...codes],
  );


  return [
    ...codes,
  ];
}



/* =========================================================
   WOS Rewardsからギフトコード取得
========================================================= */

async function getWosRewardsGiftCodes() {

  const controller =
    new AbortController();


  const timer =
    setTimeout(

      () =>
        controller.abort(),

      WOS_REWARDS_TIMEOUT_MS,
    );


  let response;


  try {

    response =
      await fetch(

        WOS_REWARDS_URL,

        {
          method:
            "GET",


          headers: {

            Accept:
              "text/html,application/xhtml+xml,*/*;q=0.8",

            "Accept-Language":
              "en-US,en;q=0.9",

            "User-Agent":
              "Mozilla/5.0 (compatible; WOSGiftAuto/4.1)",
          },


          signal:
            controller.signal,
        },
      );


  } catch (error) {


    if (
      error?.name ===
      "AbortError"
    ) {

      throw new Error(
        `WOS Rewardsタイムアウト (${WOS_REWARDS_TIMEOUT_MS}ms)`,
      );
    }


    throw error;


  } finally {

    clearTimeout(
      timer,
    );
  }


  if (!response.ok) {

    throw new Error(
      `WOS Rewards取得エラー: HTTP ${response.status}`,
    );
  }


  const html =
    await response.text();


  if (
    !html ||
    html.length < 100
  ) {

    throw new Error(
      "WOS Rewardsから有効なHTMLを取得できませんでした",
    );
  }


  /*
   * =====================================================
   * HTMLを読みやすいテキストへ変換
   * =====================================================
   *
   * script/styleは削除。
   *
   * HTMLタグを改行へ変換して
   * WOS Rewards上の表示順を
   * できるだけ維持する。
   */
  const pageText =

    decodeBasicHtmlEntities(
      html,
    )

      .replace(

        /<script\b[^>]*>[\s\S]*?<\/script>/gi,

        "\n",
      )

      .replace(

        /<style\b[^>]*>[\s\S]*?<\/style>/gi,

        "\n",
      )

      .replace(

        /<[^>]+>/g,

        "\n",
      )

      .replace(
        /\r/g,
        "",
      )

      .replace(
        /[ \t]+/g,
        " ",
      )

      .replace(
        /\n\s*\n+/g,
        "\n",
      )

      .trim();


  /*
   * =====================================================
   * Active Codes開始位置
   * =====================================================
   */
  const activeStart =

    pageText.search(

      /Active\s+Codes/i,

    );


  if (
    activeStart === -1
  ) {

    /*
     * サイト側のHTML構造が
     * 変更された可能性がある。
     *
     * 誤検知して適当な文字列を
     * ギフトコード扱いするより、
     * ここでは安全に停止する。
     */
    throw new Error(
      "WOS RewardsのActive Codes欄が見つかりません",
    );
  }


  let activeSection =

    pageText.slice(
      activeStart,
    );


  /*
   * =====================================================
   * Expired Codes開始位置
   * =====================================================
   *
   * WOS Rewardsでは
   *
   * Active Codes
   * ↓
   * 有効コード
   * ↓
   * XXX expired codes
   *
   * という並びを想定。
   *
   * Expiredより後ろは絶対に
   * ギフトコード候補として使わない。
   */
  const expiredStart =

    activeSection.search(

      /\d+\s+expired\s+codes/i,

    );


  if (
    expiredStart === -1
  ) {

    /*
     * 境界が分からない状態で
     * ページ全体を検索すると
     * 期限切れコードまで取得する
     * 危険がある。
     *
     * そのため失敗扱いにする。
     */
    throw new Error(
      "WOS RewardsのExpired Codes境界が見つかりません",
    );
  }


  activeSection =

    activeSection.slice(
      0,
      expiredStart,
    );


  /*
   * =====================================================
   * Active Codesからコード抽出
   * =====================================================
   */
  const codes =
    new Set();


  /*
   * WOS Rewards上の表示例
   *
   * Live Added ...
   * ABC123
   * Checked ...
   *
   * この構造を利用して
   * コード部分だけ取得する。
   */
  for (
    const match of
      activeSection.matchAll(

        /Live\s+Added[^\n]*\n+\s*([A-Za-z0-9_-]{4,64})\s*\n+\s*Checked/gi,

      )
  ) {

    const code =
      cleanGiftCode(
        match[1],
      );


    if (
      isValidGiftCode(
        code,
      )
    ) {

      codes.add(
        code,
      );
    }
  }


  /*
   * Active Codes欄は見つかったのに
   * 1件も取得できない場合。
   *
   * サイト構造が変更された可能性が
   * 高いため、正常扱いにはしない。
   */
  if (
    codes.size === 0
  ) {

    throw new Error(
      "WOS RewardsのActive Codesからコードを取得できませんでした",
    );
  }


  console.log(
    "WOS Rewards active codes:",
    [...codes],
  );


  return [
    ...codes,
  ];
}



/* =========================================================
   ギフトコード文字列を整理
========================================================= */

function cleanGiftCode(
  value,
) {

  return String(
    value || "",
  )

    .trim()

    /*
     * 先頭の引用符などを除去
     */
    .replace(
      /^["'`]+/,
      "",
    )

    /*
     * 末尾に付いた句読点などを除去
     */
    .replace(
      /["'`,.;:!?]+$/,
      "",
    );
}



/* =========================================================
   ギフトコードとして妥当か確認
========================================================= */

function isValidGiftCode(
  code,
) {

  /*
   * コードとして使える文字だけ許可
   */
  if (
    !/^[A-Za-z0-9_-]{4,64}$/
      .test(code)
  ) {

    return false;
  }


  /*
   * HTMLや文章から
   * 誤検知しやすい単語を除外
   */
  const blocked =
    new Set([

      "code",

      "codes",

      "gift",

      "redeem",

      "copy",

      "active",

      "expired",
    ]);


  return !blocked.has(

    code.toLowerCase(),

  );
}



/* =========================================================
   基本的なHTML Entityを戻す
========================================================= */

function decodeBasicHtmlEntities(
  value,
) {

  return String(
    value || "",
  )

    .replace(
      /&amp;/gi,
      "&",
    )

    .replace(
      /&quot;/gi,
      '"',
    )

    .replace(
      /&#39;/gi,
      "'",
    )

    .replace(
      /&lt;/gi,
      "<",
    )

    .replace(
      /&gt;/gi,
      ">",
    )

    .replace(
      /&colon;/gi,
      ":",
    )

    .replace(
      /&#58;/gi,
      ":",
    )

    .replace(
      /&nbsp;/gi,
      " ",
    );
}



/* =========================================================
   検知したギフトコードを処理
========================================================= */

async function processDetectedCodes(
  detectedCodes,
  env,
) {

  /*
   * =====================================================
   * 全取得元のコードを整理・重複排除
   * =====================================================
   *
   * 現在の取得元：
   *
   * ・Discord
   * ・WOS Rewards
   */
  const codes =
    new Set();


  for (
    const value of
      detectedCodes
  ) {

    const code =
      cleanGiftCode(
        value,
      );


    if (
      isValidGiftCode(
        code,
      )
    ) {

      codes.add(
        code,
      );
    }
  }


  /*
   * =====================================================
   * 見つけたコードをcode_jobsへ保存
   * =====================================================
   *
   * 初めて見つかったコード：
   * next_member_id = 0
   *
   * 既存コード：
   * INSERT OR IGNOREなので
   * 既存の処理進捗を維持する。
   */
  for (
    const code of codes
  ) {

    await env.MEMBERS_DB
      .prepare(`
        INSERT OR IGNORE
        INTO code_jobs
        (
          code,
          notified,
          locked_until,
          next_member_id
        )

        VALUES
        (
          ?,
          0,
          0,
          0
        )
      `)

      .bind(
        code,
      )

      .run();
  }


  /*
   * =====================================================
   * 現在確認できるコードだけ処理
   * =====================================================
   *
   * ・直近24時間のDiscord投稿に存在するコード
   * ・WOS RewardsのActive Codesに存在するコード
   *
   * のいずれかに該当するものだけを見る。
   *
   * 過去にcode_jobsへ保存されていても、
   * 現在どちらにも存在しないコードは
   * このCronでは処理されない。
   */
  const activeCodes = [
    ...codes,
  ];


  if (
    activeCodes.length === 0
  ) {

    console.log(
      "No active gift codes detected",
    );

    return;
  }


  const placeholders =

    activeCodes
      .map(
        () => "?",
      )
      .join(", ");


  /*
   * =====================================================
   * 処理が必要なコードだけ取得
   * =====================================================
   */
  const {
    results: jobs = [],
  } =

    await env.MEMBERS_DB
      .prepare(`
        SELECT
          code

        FROM code_jobs

        WHERE
          code IN (${placeholders})
          AND notified = 0

        ORDER BY
          created_at ASC

        LIMIT 10
      `)

      .bind(
        ...activeCodes,
      )

      .all();


  /*
   * 各コードを登録者へ配布
   */
  for (
    const job of jobs
  ) {

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

  const now =
    Math.floor(
      Date.now() / 1000,
    );


  /*
   * 3分間ロック
   */
  const lockUntil =
    now + 180;


  /*
   * =====================================================
   * このコードの処理権を取得
   * =====================================================
   */
  const lockResult =

    await env.MEMBERS_DB
      .prepare(`
        UPDATE code_jobs

        SET
          locked_until = ?

        WHERE
          code = ?
          AND locked_until < ?
          AND notified = 0
      `)

      .bind(
        lockUntil,
        code,
        now,
      )

      .run();


  const changed =
    Number(

      lockResult
        ?.meta
        ?.changes ??

      lockResult
        ?.changes ??

      0,
    );


  /*
   * 他のCronが処理中、
   * または既に完了済み。
   */
  if (
    changed === 0
  ) {

    console.log(
      `code ${code}: locked or completed`,
    );

    return;
  }


  try {

    /*
     * 現在の進捗位置を取得
     */
    const job =
      await env.MEMBERS_DB
        .prepare(`
          SELECT
            next_member_id

          FROM code_jobs

          WHERE
            code = ?

          LIMIT 1
        `)

        .bind(
          code,
        )

        .first();


    const nextMemberId =
      Number(
        job?.next_member_id || 0,
      );


    /*
     * =====================================================
     * 次の登録者を最大10人取得
     * =====================================================
     *
     * 前回処理したmember_idの
     * 続きから取得する。
     */
    const {
      results: members = [],
    } =

      await env.MEMBERS_DB
        .prepare(`
          SELECT
            id,
            player_name,
            player_id,
            kingdom_id

          FROM members

          WHERE
            active = 1
            AND id > ?

          ORDER BY
            id ASC

          LIMIT ?
        `)

        .bind(
          nextMemberId,
          MAX_MEMBERS_PER_RUN,
        )

        .all();


    /*
     * カーソルより後ろに
     * 登録者がいない。
     */
    if (
      members.length === 0
    ) {

      await finishCodeJob(
        code,
        env,
      );

      return;
    }


    /*
     * =====================================================
     * 最終結果として保存するAPI結果
     * =====================================================
     *
     * ここに含まれない結果は
     * 一時的・未知のエラーとして扱い、
     * 次回Cronで再試行する。
     */
    const finalCodes =
      new Set([

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


    /*
     * このCronで
     * どこまで処理できたか
     */
    let lastCompletedMemberId =
      nextMemberId;


    /*
     * 各登録者を処理
     */
    for (
      const member of members
    ) {

      /*
       * 念のため既に処理済みか確認。
       *
       * 同じコードを同じmemberへ
       * 二重送信しない。
       */
      const alreadyProcessed =
        await env.MEMBERS_DB
          .prepare(`
            SELECT 1

            FROM processed_codes

            WHERE
              code = ?
              AND member_id = ?

            LIMIT 1
          `)

          .bind(
            code,
            member.id,
          )

          .first();


      if (
        alreadyProcessed
      ) {

        lastCompletedMemberId =
          Number(
            member.id,
          );

        continue;
      }


      try {

        /*
         * ホワサバAPIへ受取要求
         */
        const result =
          await redeem(

            code,

            member.player_id,

            member.kingdom_id,
          );


        console.log(

          "redeem result:",

          {
            code,

            player:
              member.player_id,

            errCode:
              result.errCode,

            message:
              result.message,
          },
        );


        /*
         * =================================================
         * 未知・一時的な結果
         * =================================================
         *
         * DBへ確定結果として保存しない。
         *
         * このmemberで処理を止め、
         * 次回Cronで同じ人から再試行する。
         */
        if (
          !finalCodes.has(
            result.errCode,
          )
        ) {

          console.log(

            `retry later: code=${code} player=${member.player_id} err=${result.errCode}`,

          );

          break;
        }


        /*
         * =================================================
         * 最終結果を保存
         * =================================================
         */
        await env.MEMBERS_DB
          .prepare(`
            INSERT OR REPLACE
            INTO processed_codes
            (
              code,
              member_id,
              err_code,
              message
            )

            VALUES (
              ?,
              ?,
              ?,
              ?
            )
          `)

          .bind(
            code,
            member.id,
            result.errCode,
            result.message,
          )

          .run();


        /*
         * この人は処理確定。
         * カーソルを進める。
         */
        lastCompletedMemberId =
          Number(
            member.id,
          );


      } catch (error) {

        /*
         * 通信エラーやタイムアウト。
         *
         * processed_codesへ保存せず、
         * カーソルも進めない。
         *
         * 次回Cronで再試行する。
         */
        console.error(

          `redeem error: code=${code} name=${member.player_name} player=${member.player_id}`,

          error,
        );


        break;
      }
    }


    /*
     * =====================================================
     * 今回確定した位置までカーソル保存
     * =====================================================
     */
    if (
      lastCompletedMemberId >
      nextMemberId
    ) {

      await env.MEMBERS_DB
        .prepare(`
          UPDATE code_jobs

          SET
            next_member_id = ?

          WHERE
            code = ?
        `)

        .bind(
          lastCompletedMemberId,
          code,
        )

        .run();
    }


    /*
     * =====================================================
     * 後ろに登録者が残っているか確認
     * =====================================================
     *
     * COUNT(*)はせず、
     * 次の1人が存在するかだけ確認。
     */
    const nextMember =
      await env.MEMBERS_DB
        .prepare(`
          SELECT id

          FROM members

          WHERE
            active = 1
            AND id > ?

          ORDER BY
            id ASC

          LIMIT 1
        `)

        .bind(
          lastCompletedMemberId,
        )

        .first();


    /*
     * 次の人がいる。
     *
     * 次回Cronで続きを処理。
     */
    if (
      nextMember
    ) {

      console.log(
        `code ${code}: continue after member ${lastCompletedMemberId}`,
      );

      return;
    }


    /*
     * 次の人がいない。
     *
     * 現在登録されている人への
     * 処理は完了。
     */
    await finishCodeJob(
      code,
      env,
    );


  } finally {

    /*
     * 成功・失敗に関係なく
     * ロック解除
     */
    await env.MEMBERS_DB
      .prepare(`
        UPDATE code_jobs

        SET
          locked_until = 0

        WHERE
          code = ?
      `)

      .bind(
        code,
      )

      .run();
  }
}



/* =========================================================
   コード処理完了
========================================================= */

async function finishCodeJob(
  code,
  env,
) {

  /*
   * =====================================================
   * 結果集計
   * =====================================================
   *
   * 全員への処理が終了した時だけ
   * 実行する。
   */
  const {
    results: rows = [],
  } =

    await env.MEMBERS_DB
      .prepare(`
        SELECT
          err_code,
          COUNT(*) AS total

        FROM processed_codes

        WHERE
          code = ?

        GROUP BY
          err_code
      `)

      .bind(
        code,
      )

      .all();


  let success = 0;
  let already = 0;
  let expired = 0;
  let invalid = 0;
  let other = 0;


  /*
   * API結果を分類
   */
  for (
    const row of rows
  ) {

    const errCode =
      String(
        row.err_code || "",
      );


    const total =
      Number(
        row.total || 0,
      );


    /*
     * 受取成功
     */
    if (
      errCode === "20000"
    ) {

      success += total;

      continue;
    }


    /*
     * 既に受取済み
     */
    if (
      errCode === "40008" ||
      errCode === "40014" ||
      errCode === "40020"
    ) {

      already += total;

      continue;
    }


    /*
     * 無効・期限切れ
     */
    if (
      errCode === "40005" ||
      errCode === "40006" ||
      errCode === "40007"
    ) {

      expired += total;

      continue;
    }


    /*
     * その他の確定エラー
     */
    if (
      errCode === "40010" ||
      errCode === "40011"
    ) {

      invalid += total;

      continue;
    }


    other += total;
  }


  /*
   * 処理人数
   */
  const totalProcessed =

    success +
    already +
    expired +
    invalid +
    other;


  /*
   * =====================================================
   * Discord通知の二重送信防止
   * =====================================================
   *
   * notified = 0 の時だけ
   * 1へ変更する。
   *
   * Cronが重なっても
   * 片方だけが通知担当になる。
   */
  const notifyLock =
    await env.MEMBERS_DB
      .prepare(`
        UPDATE code_jobs

        SET
          notified = 1

        WHERE
          code = ?
          AND notified = 0
      `)

      .bind(
        code,
      )

      .run();


  const changed =
    Number(

      notifyLock
        ?.meta
        ?.changes ??

      notifyLock
        ?.changes ??

      0,
    );


  /*
   * 既に別Cronが通知済み
   */
  if (
    changed === 0
  ) {

    return;
  }


  /*
   * =====================================================
   * Discordへ結果通知
   * =====================================================
   */
  let message =

    `🎁 **ギフトコード処理完了**

コード：
\`${code}\`

処理人数：${totalProcessed}人
✅ 受取成功：${success}人
☑️ 受取済み：${already}人`;


  if (
    expired > 0
  ) {

    message +=
      `\n⌛ 無効・期限切れ：${expired}人`;
  }


  if (
    invalid > 0
  ) {

    message +=
      `\n⚠️ その他の確定エラー：${invalid}人`;
  }


  if (
    other > 0
  ) {

    message +=
      `\n❓ その他：${other}人`;
  }


  try {

    await sendDiscordToChannel(
      env,
      RESULT_CHANNEL,
      message,
    );


  } catch (error) {

    /*
     * Discord通知だけ失敗した場合、
     * notifiedを0へ戻す。
     *
     * 次回Cronで通知だけ再試行できる。
     *
     * processed_codesは残るため
     * ギフトコードを二重受取しない。
     */
    await env.MEMBERS_DB
      .prepare(`
        UPDATE code_jobs

        SET
          notified = 0

        WHERE
          code = ?
      `)

      .bind(
        code,
      )

      .run();


    throw error;
  }


  console.log(

    `code ${code}: completed, processed=${totalProcessed}`,

  );
}

/* =========================================================
   WOSギフトコード受取API
========================================================= */

async function redeem(
  code,
  playerId,
  kingdomId,
) {

  /*
   * APIへ送る時刻
   */
  const time =
    Math.floor(
      Date.now() / 1000,
    );


  /*
   * WOS APIへ送るパラメータ
   */

  const params = {

  fid:
    String(
      playerId,
    ),

  cdk:
    String(
      code,
    ),

  kid:
    String(
      kingdomId,
    ),

  time:
    String(
      time,
    ),
};

  /*
   * =====================================================
   * 署名作成
   * =====================================================
   *
   * パラメータをキー順に並べ、
   * WOS_KEYを最後に付けて
   * MD5を作る。
   */
  const signSource =

    Object.keys(params)

      .sort()

      .map(
        (key) =>
          `${key}=${params[key]}`,
      )

      .join("&") +

    WOS_KEY;


  const sign =
    md5(
      signSource,
    );


  /*
   * API送信用データ
   */
  const body =

    new URLSearchParams({

      ...params,

      sign,
    });


  /*
   * タイムアウト制御
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
          method:
            "POST",


                    headers: {

            "Content-Type":
              "application/x-www-form-urlencoded",

            "Origin":
              "https://wos-giftcode.centurygame.com",

            "Referer":
              "https://wos-giftcode.centurygame.com/",

            "User-Agent":
              "Mozilla/5.0",
          },


          body:
            body.toString(),


          signal:
            controller.signal,
        },
      );


  } catch (error) {

    if (
      error?.name ===
      "AbortError"
    ) {

      throw new Error(
        `WOS APIタイムアウト (${REDEEM_TIMEOUT_MS}ms)`,
      );
    }


    throw error;


  } finally {

    clearTimeout(
      timer,
    );
  }


  /*
   * HTTP自体が失敗
   */
  const text =
  await response.text();

if (!response.ok) {
  console.error(
    "WOS API HTTP ERROR:",
    {
      status: response.status,
      body: text,
      playerId: String(playerId),
      kingdomId: String(kingdomId),
      code: String(code),
    },
  );

  throw new Error(
    `WOS API HTTP ${response.status}: ${text.slice(0, 500)}`,
  );
}

  let data;


  try {

    data =
      JSON.parse(
        text,
      );


  } catch {

    throw new Error(
      `WOS API JSON解析エラー: ${text.slice(0, 200)}`,
    );
  }


  /*
   * APIによって
   *
   * err_code
   * errCode
   *
   * のどちらで返ってきても
   * 同じ形式に揃える。
   */
  const errCode =
    String(

      data?.err_code ??
      data?.errCode ??
      data?.code ??
      "",

    );


  const message =
    String(

      data?.msg ??
      data?.message ??
      "",

    );


  /*
   * errCodeが取得できないレスポンスは
   * 正常結果として扱わない。
   */
  if (!errCode) {

    throw new Error(
      `WOS API結果不明: ${text.slice(0, 200)}`,
    );
  }


  return {

    errCode,

    message,

    raw:
      data,
  };
}



/* =========================================================
   HTML用エスケープ
========================================================= */

function escapeHtml(
  value,
) {

  return String(
    value ?? "",
  )

    .replace(
      /&/g,
      "&amp;",
    )

    .replace(
      /</g,
      "&lt;",
    )

    .replace(
      />/g,
      "&gt;",
    )

    .replace(
      /"/g,
      "&quot;",
    )

    .replace(
      /'/g,
      "&#39;",
    );
}



/* =========================================================
   共通メッセージページ
========================================================= */

function pageMessage(
  title,
  message,
  success = true,
) {

  const icon =
    success
      ? "✅"
      : "⚠️";


  return new Response(

    `<!DOCTYPE html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
${escapeHtml(title)}
</title>


<style>
${PAGE_STYLE}
</style>

</head>


<body>

<div class="container">

  <div class="card">

    <div class="result-icon">
      ${icon}
    </div>


    <h1>
      ${escapeHtml(title)}
    </h1>


    <p class="message">
      ${message}
    </p>


    <div class="button-area">

      <a
        class="button"
        href="/"
      >
        登録ページへ戻る
      </a>


      <a
        class="button secondary"
        href="/manage"
      >
        登録情報を確認・変更
      </a>

    </div>

  </div>

</div>

</body>

</html>`,

    {
      headers: {

        "Content-Type":
          "text/html; charset=UTF-8",
      },
    },
  );
}



/* =========================================================
   登録情報編集ページ
========================================================= */

function editMemberPage(
  member,
) {

  const playerName =
    escapeHtml(
      member.player_name,
    );


  const playerId =
    escapeHtml(
      member.player_id,
    );


  const kingdomId =
    escapeHtml(
      member.kingdom_id,
    );


  const memberId =
    Number(
      member.id,
    );


  return `<!DOCTYPE html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
登録情報の変更
</title>


<style>
${PAGE_STYLE}
</style>

</head>


<body>

<div class="container">

  <div class="card">

    <h1>
      登録情報の変更
    </h1>


    <p class="description">
      現在の登録情報です。
      変更したい項目を書き換えて、
      変更申請を送ってください。
    </p>


    <form
      method="POST"
      action="/change-request"
    >


      <input
        type="hidden"
        name="member_id"
        value="${memberId}"
      >


      <input
        type="hidden"
        name="old_player_id"
        value="${playerId}"
      >


      <input
        type="hidden"
        name="old_kingdom_id"
        value="${kingdomId}"
      >


      <label>
        プレイヤー名
      </label>


      <input
        type="text"
        name="player_name"
        maxlength="30"
        value="${playerName}"
        required
      >


      <label>
        王国番号
      </label>


      <input
        type="number"
        name="kingdom_id"
        min="1"
        max="999999"
        value="${kingdomId}"
        required
      >


      <label>
        プレイヤーID
      </label>


      <input
        type="text"
        name="player_id"
        inputmode="numeric"
        pattern="[0-9]{6,15}"
        value="${playerId}"
        required
      >


      <button
        type="submit"
      >
        変更申請を送る
      </button>

    </form>


    <p class="notice">
      ※変更内容はすぐには反映されません。
      管理者がDiscordで承認すると更新されます。
    </p>


    <div class="button-area">

      <a
        class="button secondary"
        href="/manage"
      >
        戻る
      </a>

    </div>

  </div>

</div>

</body>

</html>`;
}



/* =========================================================
   ページ共通CSS

   ★重要
   MANAGE_PAGEより前に置くこと。
========================================================= */

const PAGE_STYLE = `

* {
  box-sizing: border-box;
}


html {
  -webkit-text-size-adjust: 100%;
}


body {

  margin: 0;

  min-height: 100vh;

  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background:
    linear-gradient(
      160deg,
      #edf6ff 0%,
      #f7fbff 45%,
      #eef5ff 100%
    );

  color:
    #1f2937;
}


.container {

  width: 100%;

  max-width: 560px;

  margin:
    0 auto;

  padding:
    28px 16px 50px;
}


.card {

  background:
    rgba(
      255,
      255,
      255,
      0.96
    );

  border-radius:
    22px;

  padding:
    28px 22px;

  box-shadow:
    0 12px 35px
    rgba(
      28,
      72,
      120,
      0.12
    );
}


h1 {

  margin:
    0 0 14px;

  text-align:
    center;

  font-size:
    27px;

  line-height:
    1.35;

  color:
    #16385f;
}


.description {

  margin:
    0 0 24px;

  text-align:
    center;

  line-height:
    1.8;

  color:
    #64748b;

  font-size:
    14px;
}


label {

  display:
    block;

  margin:
    18px 0 7px;

  font-weight:
    700;

  font-size:
    14px;

  color:
    #334155;
}


input {

  width:
    100%;

  padding:
    14px 15px;

  border:
    1px solid #cbd5e1;

  border-radius:
    12px;

  background:
    #ffffff;

  color:
    #0f172a;

  font-size:
    16px;

  outline:
    none;

  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}


input:focus {

  border-color:
    #60a5fa;

  box-shadow:
    0 0 0 4px
    rgba(
      96,
      165,
      250,
      0.16
    );
}


button,
.button {

  display:
    block;

  width:
    100%;

  margin-top:
    22px;

  padding:
    14px 16px;

  border:
    0;

  border-radius:
    12px;

  background:
    #2563eb;

  color:
    #ffffff;

  font-size:
    16px;

  font-weight:
    700;

  text-align:
    center;

  text-decoration:
    none;

  cursor:
    pointer;
}


button:active,
.button:active {

  transform:
    scale(0.99);
}


.button.secondary {

  background:
    #eaf2ff;

  color:
    #24589b;
}


.button-area {

  margin-top:
    20px;
}


.notice {

  margin:
    20px 0 0;

  padding:
    13px 14px;

  border-radius:
    12px;

  background:
    #f8fafc;

  color:
    #64748b;

  font-size:
    13px;

  line-height:
    1.7;
}


.message {

  margin:
    16px 0 0;

  text-align:
    center;

  line-height:
    1.8;

  overflow-wrap:
    anywhere;
}


.result-icon {

  margin-bottom:
    10px;

  text-align:
    center;

  font-size:
    46px;
}


small {

  display:
    block;

  margin-top:
    18px;

  text-align:
    center;

  color:
    #64748b;

  line-height:
    1.7;
}


.info-box {

  margin-top:
    18px;

  padding:
    14px;

  border-radius:
    12px;

  background:
    #eff6ff;

  color:
    #31577f;

  font-size:
    13px;

  line-height:
    1.7;
}


hr {

  border:
    0;

  border-top:
    1px solid #e2e8f0;

  margin:
    28px 0;
}


@media (
  max-width: 480px
) {

  .container {

    padding:
      18px 12px 40px;
  }


  .card {

    padding:
      24px 17px;

    border-radius:
      18px;
  }


  h1 {

    font-size:
      24px;
  }
}

`;

/* =========================================================
   登録情報確認ページ
========================================================= */

const MANAGE_PAGE = `<!DOCTYPE html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
登録情報の確認・変更
</title>


<style>
${PAGE_STYLE}
</style>

</head>


<body>

<div class="container">

  <div class="card">

    <h1>
      登録情報の確認・変更
    </h1>


    <p class="description">
      登録したプレイヤーIDと王国番号を入力してください。
      現在の登録情報を確認できます。
    </p>


    <form
      method="POST"
      action="/lookup-member"
    >


      <label>
        王国番号
      </label>


      <input
        type="number"
        name="kingdom_id"
        min="1"
        max="999999"
        inputmode="numeric"
        placeholder="例：3338"
        required
      >


      <label>
        プレイヤーID
      </label>


      <input
        type="text"
        name="player_id"
        inputmode="numeric"
        pattern="[0-9]{6,15}"
        placeholder="例：123456789"
        required
      >


      <button
        type="submit"
      >
        登録情報を確認
      </button>

    </form>


    <div class="button-area">

      <a
        class="button secondary"
        href="/"
      >
        新規登録ページへ戻る
      </a>

    </div>

  </div>

</div>

</body>

</html>`;



/* =========================================================
   新規登録ページ
========================================================= */

const REGISTRATION_PAGE = `<!DOCTYPE html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>
WOS ギフトコード自動受取
</title>


<style>
${PAGE_STYLE}
</style>

</head>


<body>

<div class="container">

  <div class="card">

    <h1>
      🎁 WOS ギフトコード自動受取
    </h1>


    <p class="description">
      プレイヤー情報を登録すると、
      検知したギフトコードを自動で受け取ります。
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
        王国番号
      </label>


      <input
        type="number"
        name="kingdom_id"
        min="1"
        max="999999"
        inputmode="numeric"
        placeholder="例：3338"
        required
      >


      <label>
        プレイヤーID
      </label>


      <input
        type="text"
        name="player_id"
        inputmode="numeric"
        pattern="[0-9]{6,15}"
        placeholder="例：123456789"
        required
      >


      <button
        type="submit"
      >
        登録する
      </button>

    </form>


    <small>
      登録後、現在有効なギフトコードを
      順番に自動受取します。
    </small>


    <hr>


    <div class="info-box">

      <strong>
        登録済みの方
      </strong>

      <br>

      名前・王国番号・プレイヤーIDを
      変更したい場合は、
      下のボタンから登録情報を確認できます。

    </div>


    <div class="button-area">

      <a
        class="button secondary"
        href="/manage"
      >
        登録情報を確認・変更
      </a>

    </div>

  </div>

</div>

</body>

</html>`;

/* =========================================================
   MD5
========================================================= */

function md5(
  string,
) {

  function rotateLeft(
    lValue,
    iShiftBits,
  ) {

    return (
      lValue << iShiftBits
    ) |
    (
      lValue >>>
      (
        32 -
        iShiftBits
      )
    );
  }


  function addUnsigned(
    lX,
    lY,
  ) {

    const lX4 =
      lX & 0x40000000;

    const lY4 =
      lY & 0x40000000;

    const lX8 =
      lX & 0x80000000;

    const lY8 =
      lY & 0x80000000;

    const lResult =
      (
        lX &
        0x3fffffff
      ) +
      (
        lY &
        0x3fffffff
      );


    if (
      lX4 & lY4
    ) {

      return (
        lResult ^
        0x80000000 ^
        lX8 ^
        lY8
      );
    }


    if (
      lX4 | lY4
    ) {

      if (
        lResult &
        0x40000000
      ) {

        return (
          lResult ^
          0xc0000000 ^
          lX8 ^
          lY8
        );

      } else {

        return (
          lResult ^
          0x40000000 ^
          lX8 ^
          lY8
        );
      }
    }


    return (
      lResult ^
      lX8 ^
      lY8
    );
  }


  function f(
    x,
    y,
    z,
  ) {

    return (
      x & y
    ) |
    (
      ~x & z
    );
  }


  function g(
    x,
    y,
    z,
  ) {

    return (
      x & z
    ) |
    (
      y & ~z
    );
  }


  function h(
    x,
    y,
    z,
  ) {

    return (
      x ^
      y ^
      z
    );
  }


  function i(
    x,
    y,
    z,
  ) {

    return (
      y ^
      (
        x |
        ~z
      )
    );
  }


  function ff(
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
            f(
              b,
              c,
              d,
            ),
            x,
          ),
          ac,
        ),
      );


    return addUnsigned(
      rotateLeft(
        a,
        s,
      ),
      b,
    );
  }


  function gg(
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
            g(
              b,
              c,
              d,
            ),
            x,
          ),
          ac,
        ),
      );


    return addUnsigned(
      rotateLeft(
        a,
        s,
      ),
      b,
    );
  }


  function hh(
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
            h(
              b,
              c,
              d,
            ),
            x,
          ),
          ac,
        ),
      );


    return addUnsigned(
      rotateLeft(
        a,
        s,
      ),
      b,
    );
  }


  function ii(
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
            i(
              b,
              c,
              d,
            ),
            x,
          ),
          ac,
        ),
      );


    return addUnsigned(
      rotateLeft(
        a,
        s,
      ),
      b,
    );
  }


  function convertToWordArray(
    value,
  ) {

    const messageLength =
      value.length;


    const numberOfWordsTempOne =
      messageLength + 8;


    const numberOfWordsTempTwo =
      (
        numberOfWordsTempOne -
        (
          numberOfWordsTempOne %
          64
        )
      ) /
      64;


    const numberOfWords =
      (
        numberOfWordsTempTwo + 1
      ) *
      16;


    const wordArray =
      new Array(
        numberOfWords - 1,
      );


    let bytePosition = 0;
    let byteCount = 0;


    while (
      byteCount <
      messageLength
    ) {

      const wordCount =
        (
          byteCount -
          (
            byteCount %
            4
          )
        ) /
        4;


      bytePosition =
        (
          byteCount %
          4
        ) *
        8;


      wordArray[wordCount] =
        (
          wordArray[wordCount] |
          (
            value.charCodeAt(
              byteCount,
            ) <<
            bytePosition
          )
        );


      byteCount++;
    }


    const wordCount =
      (
        byteCount -
        (
          byteCount %
          4
        )
      ) /
      4;


    bytePosition =
      (
        byteCount %
        4
      ) *
      8;


    wordArray[wordCount] =
      wordArray[wordCount] |
      (
        0x80 <<
        bytePosition
      );


    wordArray[
      numberOfWords - 2
    ] =
      messageLength << 3;


    wordArray[
      numberOfWords - 1
    ] =
      messageLength >>> 29;


    return wordArray;
  }


  function wordToHex(
    lValue,
  ) {

    let wordToHexValue = "";
    let wordToHexValueTemp = "";


    for (
      let count = 0;
      count <= 3;
      count++
    ) {

      const byte =
        (
          lValue >>>
          (
            count * 8
          )
        ) &
        255;


      wordToHexValueTemp =
        "0" +
        byte.toString(16);


      wordToHexValue +=
        wordToHexValueTemp.substr(
          wordToHexValueTemp.length - 2,
          2,
        );
    }


    return wordToHexValue;
  }


  function utf8Encode(
    value,
  ) {

    value =
      value.replace(
        /\r\n/g,
        "\n",
      );


    let utfText = "";


    for (
      let n = 0;
      n < value.length;
      n++
    ) {

      const c =
        value.charCodeAt(
          n,
        );


      if (
        c < 128
      ) {

        utfText +=
          String.fromCharCode(
            c,
          );


      } else if (
        c > 127 &&
        c < 2048
      ) {

        utfText +=
          String.fromCharCode(
            (
              c >> 6
            ) |
            192,
          );


        utfText +=
          String.fromCharCode(
            (
              c &
              63
            ) |
            128,
          );


      } else {

        utfText +=
          String.fromCharCode(
            (
              c >> 12
            ) |
            224,
          );


        utfText +=
          String.fromCharCode(
            (
              (
                c >> 6
              ) &
              63
            ) |
            128,
          );


        utfText +=
          String.fromCharCode(
            (
              c &
              63
            ) |
            128,
          );
      }
    }


    return utfText;
  }


  let x = [];

  let k;

  let aa;
  let bb;
  let cc;
  let dd;

  let a =
    0x67452301;

  let b =
    0xefcdab89;

  let c =
    0x98badcfe;

  let d =
    0x10325476;


  const s11 = 7;
  const s12 = 12;
  const s13 = 17;
  const s14 = 22;

  const s21 = 5;
  const s22 = 9;
  const s23 = 14;
  const s24 = 20;

  const s31 = 4;
  const s32 = 11;
  const s33 = 16;
  const s34 = 23;

  const s41 = 6;
  const s42 = 10;
  const s43 = 15;
  const s44 = 21;


  string =
    utf8Encode(
      string,
    );


  x =
    convertToWordArray(
      string,
    );


  for (
    k = 0;
    k < x.length;
    k += 16
  ) {

    aa = a;
    bb = b;
    cc = c;
    dd = d;


    a = ff(a,b,c,d,x[k+0],s11,0xd76aa478);
    d = ff(d,a,b,c,x[k+1],s12,0xe8c7b756);
    c = ff(c,d,a,b,x[k+2],s13,0x242070db);
    b = ff(b,c,d,a,x[k+3],s14,0xc1bdceee);

    a = ff(a,b,c,d,x[k+4],s11,0xf57c0faf);
    d = ff(d,a,b,c,x[k+5],s12,0x4787c62a);
    c = ff(c,d,a,b,x[k+6],s13,0xa8304613);
    b = ff(b,c,d,a,x[k+7],s14,0xfd469501);

    a = ff(a,b,c,d,x[k+8],s11,0x698098d8);
    d = ff(d,a,b,c,x[k+9],s12,0x8b44f7af);
    c = ff(c,d,a,b,x[k+10],s13,0xffff5bb1);
    b = ff(b,c,d,a,x[k+11],s14,0x895cd7be);

    a = ff(a,b,c,d,x[k+12],s11,0x6b901122);
    d = ff(d,a,b,c,x[k+13],s12,0xfd987193);
    c = ff(c,d,a,b,x[k+14],s13,0xa679438e);
    b = ff(b,c,d,a,x[k+15],s14,0x49b40821);


    a = gg(a,b,c,d,x[k+1],s21,0xf61e2562);
    d = gg(d,a,b,c,x[k+6],s22,0xc040b340);
    c = gg(c,d,a,b,x[k+11],s23,0x265e5a51);
    b = gg(b,c,d,a,x[k+0],s24,0xe9b6c7aa);

    a = gg(a,b,c,d,x[k+5],s21,0xd62f105d);
    d = gg(d,a,b,c,x[k+10],s22,0x02441453);
    c = gg(c,d,a,b,x[k+15],s23,0xd8a1e681);
    b = gg(b,c,d,a,x[k+4],s24,0xe7d3fbc8);

    a = gg(a,b,c,d,x[k+9],s21,0x21e1cde6);
    d = gg(d,a,b,c,x[k+14],s22,0xc33707d6);
    c = gg(c,d,a,b,x[k+3],s23,0xf4d50d87);
    b = gg(b,c,d,a,x[k+8],s24,0x455a14ed);

    a = gg(a,b,c,d,x[k+13],s21,0xa9e3e905);
    d = gg(d,a,b,c,x[k+2],s22,0xfcefa3f8);
    c = gg(c,d,a,b,x[k+7],s23,0x676f02d9);
    b = gg(b,c,d,a,x[k+12],s24,0x8d2a4c8a);


    a = hh(a,b,c,d,x[k+5],s31,0xfffa3942);
    d = hh(d,a,b,c,x[k+8],s32,0x8771f681);
    c = hh(c,d,a,b,x[k+11],s33,0x6d9d6122);
    b = hh(b,c,d,a,x[k+14],s34,0xfde5380c);

    a = hh(a,b,c,d,x[k+1],s31,0xa4beea44);
    d = hh(d,a,b,c,x[k+4],s32,0x4bdecfa9);
    c = hh(c,d,a,b,x[k+7],s33,0xf6bb4b60);
    b = hh(b,c,d,a,x[k+10],s34,0xbebfbc70);

    a = hh(a,b,c,d,x[k+13],s31,0x289b7ec6);
    d = hh(d,a,b,c,x[k+0],s32,0xeaa127fa);
    c = hh(c,d,a,b,x[k+3],s33,0xd4ef3085);
    b = hh(b,c,d,a,x[k+6],s34,0x04881d05);

    a = hh(a,b,c,d,x[k+9],s31,0xd9d4d039);
    d = hh(d,a,b,c,x[k+12],s32,0xe6db99e5);
    c = hh(c,d,a,b,x[k+15],s33,0x1fa27cf8);
    b = hh(b,c,d,a,x[k+2],s34,0xc4ac5665);


    a = ii(a,b,c,d,x[k+0],s41,0xf4292244);
    d = ii(d,a,b,c,x[k+7],s42,0x432aff97);
    c = ii(c,d,a,b,x[k+14],s43,0xab9423a7);
    b = ii(b,c,d,a,x[k+5],s44,0xfc93a039);

    a = ii(a,b,c,d,x[k+12],s41,0x655b59c3);
    d = ii(d,a,b,c,x[k+3],s42,0x8f0ccc92);
    c = ii(c,d,a,b,x[k+10],s43,0xffeff47d);
    b = ii(b,c,d,a,x[k+1],s44,0x85845dd1);

    a = ii(a,b,c,d,x[k+8],s41,0x6fa87e4f);
    d = ii(d,a,b,c,x[k+15],s42,0xfe2ce6e0);
    c = ii(c,d,a,b,x[k+6],s43,0xa3014314);
    b = ii(b,c,d,a,x[k+13],s44,0x4e0811a1);

    a = ii(a,b,c,d,x[k+4],s41,0xf7537e82);
    d = ii(d,a,b,c,x[k+11],s42,0xbd3af235);
    c = ii(c,d,a,b,x[k+2],s43,0x2ad7d2bb);
    b = ii(b,c,d,a,x[k+9],s44,0xeb86d391);


    a =
      addUnsigned(
        a,
        aa,
      );

    b =
      addUnsigned(
        b,
        bb,
      );

    c =
      addUnsigned(
        c,
        cc,
      );

    d =
      addUnsigned(
        d,
        dd,
      );
  }


  return (

    wordToHex(a) +
    wordToHex(b) +
    wordToHex(c) +
    wordToHex(d)

  ).toLowerCase();
}

