const SOURCE_CHANNEL = "1542165450207527094";
const RESULT_CHANNEL = "1542167671154409563";

/*
 * 登録情報の変更申請を送るDiscordチャンネル
 */
const CHANGE_REQUEST_CHANNEL = "1552354610021408768";

const WOS_API =
  "https://wos-giftcode-api.centurygame.com/api/gift_code";

const WOS_KEY = "tB87#kPtkxqOS2";


/*
 * 新しく登録した人にも必ず適用する常設コード。
 */
const PERMANENT_CODES = [
  "GuDokYTKOR",
  "2ndYoutubeKR",
  "1stYoutubeKR",
  "gogoWOS",
];


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
   * 変更申請の承認・却下を確認
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
   * ギフトコード確認
   */
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
     *
     * next_member_id:
     * どのmember_idまで探索したかを記録する。
     *
     * これによって毎分先頭から全登録者を
     * 探し直す処理を減らす。
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


    /*
     * activeな登録者を
     * id順に取得する処理用
     */
    env.MEMBERS_DB.prepare(`
      CREATE INDEX IF NOT EXISTS
      idx_members_active_id

      ON members(
        active,
        id
      )
    `),


    /*
     * member_idから受取履歴を
     * 削除・検索するとき用
     */
    env.MEMBERS_DB.prepare(`
      CREATE INDEX IF NOT EXISTS
      idx_processed_codes_member_id

      ON processed_codes(
        member_id
      )
    `),


    /*
     * pending変更申請検索用
     */
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
   * 既存のcode_jobsには
   * next_member_id列がないため、
   * 初回だけ追加する。
   *
   * 既に追加済みなら
   * duplicate columnエラーを無視。
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
   * 改善版ではcode_jobsが
   * next_member_idを覚えている。
   *
   * 新規登録者のIDは通常、
   * 既存memberより大きいため、
   * 完了済みジョブを再度開けば
   * この新規登録者だけを後から処理できる。
   *
   * notifiedを0に戻すことで
   * 現在Discord上に存在するコードと
   * 常設コードが次回Cronで処理される。
   *
   * next_member_idは戻さない。
   * 新しいmember_idは既存カーソルより
   * 大きいため、そのままでよい。
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
    )}で登録しました。約1分後から常設コードと現在有効なギフトコードを順番に自動受取します。`,

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
   * 同じ登録者から既に申請が
   * 出ていないか確認。
   *
   * Part 1で追加した
   * idx_change_requests_member_status
   * がここで使われる。
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
   * 現在の登録情報を取得。
   *
   * member_idだけでなく、
   * 検索時点のID・王国番号も一致するか確認する。
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
     * Discordへ申請を送れなかった場合、
     * DBだけに申請を残すと
     * 管理者が気付けない。
     *
     * そのためpending申請を削除して
     * ユーザーに再申請してもらう。
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
            "WOSGiftAuto (Cloudflare Workers, 3.0)",
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
     * 却下
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
     * 変更後の
     * ID + 王国番号が
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

      /*
       * UNIQUE制約などで
       * UPDATEできなかった場合
       */
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
     * IDを変更した場合
     * =====================================================
     *
     * 同じmember_idの受取履歴を削除する。
     *
     * さらにcode_jobsのカーソルを
     * このmemberより前まで戻す。
     *
     * これによって現在有効なコードが
     * 新しいプレイヤーIDに対して
     * 再度処理される。
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


      /*
       * カーソルを変更対象memberの
       * 1つ手前まで戻す。
       *
       * MINを使う代わりにCASEで
       * 現在のカーソルより前の場合だけ戻す。
       */
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


    /*
     * 念のため
     */
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

async function checkDiscord(env) {

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


  /*
   * 常設コードは
   * Discordの表示位置に関係なく
   * 常に処理対象へ含める。
   */
  const codes =
    new Set(
      PERMANENT_CODES,
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
     * 例：
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

      codes.add(
        match[1],
      );
    }
  }


  /*
   * =====================================================
   * 見つけたコードをcode_jobsへ保存
   * =====================================================
   *
   * 旧版ではここで
   *
   * members
   * LEFT JOIN processed_codes
   *
   * を使って、
   * コードごとに未処理者がいるか
   * 毎分調べていた。
   *
   * 改善版ではそれをしない。
   *
   * 新しいコードなら
   * next_member_id = 0
   * から開始する。
   *
   * 既存コードなら
   * INSERT OR IGNOREなので
   * DB上の進捗をそのまま維持する。
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
   * 今Discord上で確認できるコード +
   * 常設コードだけを処理する。
   */
  const activeCodes = [
    ...codes,
  ];


  if (
    activeCodes.length === 0
  ) {

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
   *
   * 旧版：
   *
   * notified = 0
   * OR EXISTS (
   *   members
   *   LEFT JOIN processed_codes...
   * )
   *
   * という重い判定を毎分行っていた。
   *
   * 改善版：
   *
   * notified = 0
   *
   * だけを見る。
   *
   * 新規登録やID変更があった場合は
   * その時点でnotifiedを0へ戻すので、
   * 毎分members全体を調べる必要がない。
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
   *
   * 旧版ではロック取得時にも
   * members + processed_codesを調べていた。
   *
   * 改善版はcode_jobsの1行だけを見る。
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
     * 現在の進捗位置を取得。
     *
     * code_jobsはPRIMARY KEY(code)なので
     * 基本的に1行だけ読む。
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
     * ここが今回一番重要。
     *
     * 旧版：
     *
     * members全体
     * LEFT JOIN processed_codes
     * WHERE p.member_id IS NULL
     *
     * ↓
     *
     * 毎回「誰が未処理か」を
     * 過去履歴と照合して探していた。
     *
     *
     * 改善版：
     *
     * WHERE
     *   active = 1
     *   AND id > 前回位置
     *
     * ↓
     *
     * 前回処理した人の続きから
     * 最大10人だけ読む。
     *
     * idx_members_active_idを使えるため
     * 登録者が増えても読み取り量が
     * 増えにくい。
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
     * =====================================================
     * 次に処理する人が0人
     * =====================================================
     *
     * カーソルより後ろに登録者がいないので
     * このコードは現時点で全員処理済み。
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
     * 最終結果としてDBに保存する
     * ホワサバAPIの結果コード
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
     * どこまで進めたか。
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
       * 念のため、
       * このコードを既に処理済みなら
       * APIへ二重送信しない。
       *
       * PRIMARY KEY(code, member_id)で
       * 直接検索できる。
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

        /*
         * 既に処理済みなら
         * カーソルだけ先へ進められる。
         */
        lastCompletedMemberId =
          Number(
            member.id,
          );

        continue;
      }


      try {

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
         * 一時的・未知の結果は
         * DBに保存しない。
         *
         * このmemberでカーソルを止める。
         *
         * 次回Cronではこの人から
         * 再試行する。
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
         * 最終結果を保存
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
         * この人は最終結果まで確定したので
         * カーソルを進める。
         */
        lastCompletedMemberId =
          Number(
            member.id,
          );


      } catch (error) {

        /*
         * 通信失敗など。
         *
         * DBへ最終結果を保存せず
         * カーソルもこの人より先へ進めない。
         *
         * これにより次回Cronで
         * 同じ人から再試行する。
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
     * 今回確定した位置までカーソルを保存
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
     * COUNT(*)やprocessed_codesとのJOINはしない。
     *
     * 「次の1人が存在するか」
     * だけをインデックスから確認する。
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
     * 次回Cronで続きを処理する。
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
     * 次の人がいないので
     * 現時点の登録者は全員処理済み。
     */
    await finishCodeJob(
      code,
      env,
    );


  } finally {

    /*
     * 成功・失敗に関係なく
     * コードのロック解除
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
   * この集計は「全員への処理が終わった時」
   * だけ実行する。
   *
   * 毎分実行しないのがポイント。
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
   * API結果を集計
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
     * 成功
     */
    if (
      errCode === "20000"
    ) {

      success += total;

      continue;
    }


    /*
     * 既に受取済み
     *
     * 現行コードで使っている
     * 40008 / 40014 / 40020 系を
     * まとめて表示する。
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
     * 無効・期限切れ系
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
   * 合計
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
   * notified = 0 のときだけ
   * 1へ変更できる。
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
     * 次回Cronで通知を再試行できる。
     *
     * ギフトコード自体は
     * processed_codesに保存済みなので
     * 再受取されない。
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
   Whiteout Survival
   ギフトコード受取
========================================================= */

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


  /*
   * 現行と同じ署名方式を維持
   */
  const sign =
    md5(
      `cdk=${code}&fid=${playerId}&kid=${kingdomId}&time=${time}${WOS_KEY}`,
    );


  const body =
    new URLSearchParams({

      cdk:
        code,

      fid:
        playerId,

      kid:
        kingdomId,

      time,

      sign,
    });


  /*
   * APIタイムアウト
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

  } catch (error) {

    /*
     * タイムアウト・通信失敗は
     * processed_codesへ保存されない。
     *
     * そのため次回Cronで再試行される。
     */
    if (
      error?.name ===
      "AbortError"
    ) {

      throw new Error(
        `ホワサバAPIタイムアウト (${REDEEM_TIMEOUT_MS}ms)`,
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

      `ホワサバAPIエラー: HTTP ${response.status}`,

    );
  }


  let data;


  try {

    data =
      await response.json();

  } catch (_error) {

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
   ギフトコード結果をDiscordへ送信
========================================================= */

async function sendDiscord(
  env,
  content,
) {

  return sendDiscordToChannel(

    env,

    RESULT_CHANNEL,

    content,
  );
}



/* =========================================================
   メッセージページ
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
${escapeHtml(title)}
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
${escapeHtml(title)}
</h1>


<p>
${message}
</p>


<div class="page-links">

<a href="/">
新規登録
</a>

<a href="/manage">
登録情報を確認・変更
</a>

</div>

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

function escapeHtml(
  value,
) {

  return String(value)
    .replace(

      /[&<>"']/g,

      (char) =>
        ({

          "&":
            "&amp;",

          "<":
            "&lt;",

          ">":
            "&gt;",

          '"':
            "&quot;",

          "'":
            "&#39;",

        })[char],
    );
}

/* =========================================================
   登録情報編集ページ
========================================================= */

function editMemberPage(
  member,
) {

  return `
<!doctype html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
登録情報を変更
</title>

<style>
${PAGE_STYLE}
</style>

</head>


<body>

<main>

<div class="logo">
✏️
</div>


<h1>
登録情報を変更
</h1>


<p>
現在の登録情報です。
変更したい項目を書き換えて、
変更申請を送ってください。
</p>


<div class="info-box">

<div class="info-label">
現在の登録
</div>

<div class="info-row">
<span>
名前
</span>

<strong>
${escapeHtml(
  member.player_name,
)}
</strong>
</div>


<div class="info-row">
<span>
プレイヤーID
</span>

<strong>
${escapeHtml(
  member.player_id,
)}
</strong>
</div>


<div class="info-row">
<span>
王国
</span>

<strong>
${escapeHtml(
  member.kingdom_id,
)}
</strong>
</div>

</div>


<form
  method="POST"
  action="/change-request"
>


<input
  type="hidden"
  name="member_id"
  value="${Number(
    member.id,
  )}"
>


<input
  type="hidden"
  name="old_player_id"
  value="${escapeHtml(
    member.player_id,
  )}"
>


<input
  type="hidden"
  name="old_kingdom_id"
  value="${escapeHtml(
    member.kingdom_id,
  )}"
>


<label>
プレイヤー名
</label>

<input
  type="text"
  name="player_name"
  maxlength="30"
  value="${escapeHtml(
    member.player_name,
  )}"
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
  value="${escapeHtml(
    member.player_id,
  )}"
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
  value="${escapeHtml(
    member.kingdom_id,
  )}"
  required
>


<button type="submit">
変更を申請する
</button>


<small>
申請しただけでは登録情報は変更されません。
管理者がDiscordで承認すると反映されます。
</small>


<small>
名前・王国番号・プレイヤーIDを変更しても、
古い登録が別に残ることはありません。
現在の登録1件が更新されます。
</small>


<small>
プレイヤーIDを変更した場合のみ、
旧プレイヤーIDのギフトコード受取履歴は
新しいIDへ引き継がれません。
</small>


</form>


<div class="page-links">

<a href="/manage">
確認画面へ戻る
</a>

<a href="/">
新規登録
</a>

</div>

</main>

</body>

</html>
`;
}



/* =========================================================
   登録情報確認ページ
========================================================= */

const MANAGE_PAGE = `
<!doctype html>

<html lang="ja">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
登録情報の確認・変更
</title>

<style>
${PAGE_STYLE}
</style>

</head>


<body>

<main>

<div class="logo">
🔎
</div>


<h1>
登録情報の確認・変更
</h1>


<p>
現在登録されている
プレイヤーIDと王国番号を入力してください。
</p>


<p>
登録が見つかると、
現在の名前・ID・王国番号を確認して
変更申請を送ることができます。
</p>


<form
  method="POST"
  action="/lookup-member"
>


<label>
現在のプレイヤーID
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
現在の王国番号
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
登録情報を確認する
</button>


<small>
移民した場合は、
まず移民前の王国番号で現在の登録を検索し、
その後、新しい王国番号へ変更申請してください。
</small>


</form>


<div class="page-links">

<a href="/">
新規登録へ戻る
</a>

</div>

</main>

</body>

</html>
`;

/* =========================================================
   ページ共通CSS
========================================================= */

const PAGE_STYLE = `
* {
  box-sizing:
    border-box;
}


body {

  margin:
    0;


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
    min(
      100%,
      440px
    );


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


  margin:
    0 0 18px;
}


.logo,
.mark {

  width:
    58px;


  height:
    58px;


  border-radius:
    18px;


  display:
    grid;


  place-items:
    center;


  font-size:
    30px;


  background:
    #17385f;


  border:
    1px solid #315b8d;


  margin-bottom:
    18px;
}


form {

  display:
    grid;


  gap:
    12px;


  margin-top:
    22px;
}


label {

  color:
    #dce9f7;


  font-size:
    14px;


  font-weight:
    700;


  margin-top:
    4px;
}


input {

  width:
    100%;


  border:
    1px solid #34567d;


  border-radius:
    14px;


  padding:
    14px 15px;


  background:
    #07182c;


  color:
    #ffffff;


  font-size:
    16px;


  outline:
    none;
}


input:focus {

  border-color:
    #6ba8ff;


  box-shadow:
    0 0 0 3px #6ba8ff22;
}


button {

  border:
    0;


  border-radius:
    15px;


  padding:
    15px 18px;


  margin-top:
    8px;


  background:
    linear-gradient(
      135deg,
      #3c8cff,
      #2563eb
    );


  color:
    #ffffff;


  font-size:
    16px;


  font-weight:
    800;


  cursor:
    pointer;


  box-shadow:
    0 10px 28px #2563eb44;
}


button:active {

  transform:
    translateY(
      1px
    );
}


small {

  display:
    block;


  color:
    #8fa7c1;


  line-height:
    1.6;


  margin-top:
    6px;
}


.page-links {

  display:
    flex;


  flex-wrap:
    wrap;


  gap:
    12px;


  margin-top:
    24px;
}


.page-links a {

  color:
    #8fc1ff;


  text-decoration:
    none;


  font-size:
    14px;


  font-weight:
    700;
}


.page-links a:hover {

  text-decoration:
    underline;
}


.info-box {

  background:
    #07182c;


  border:
    1px solid #29496e;


  border-radius:
    17px;


  padding:
    16px;


  margin:
    20px 0;
}


.info-label {

  color:
    #7fa8d5;


  font-size:
    12px;


  font-weight:
    800;


  text-transform:
    uppercase;


  letter-spacing:
    .06em;


  margin-bottom:
    8px;
}


.info-row {

  display:
    flex;


  justify-content:
    space-between;


  gap:
    20px;


  padding:
    9px 0;


  border-bottom:
    1px solid #173352;
}


.info-row:last-child {

  border-bottom:
    0;
}


.info-row span {

  color:
    #91a8c0;
}


.info-row strong {

  color:
    #ffffff;


  text-align:
    right;


  overflow-wrap:
    anywhere;
}

@media (
  max-width: 520px
) {

  body {

    padding:
      14px;
  }


  main {

    padding:
      23px;


    border-radius:
      22px;
  }


  h1 {

    font-size:
      25px;
  }
}
`;



/* =========================================================
   新規登録ページ
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
ホワイトアウト・サバイバルの
ギフトコードを自動で受け取ります。
</p>


<p>
プレイヤー情報を登録すると、
新しいギフトコードが検知された際に
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
  autocomplete="off"
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
  autocomplete="off"
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
  autocomplete="off"
  required
>


<button type="submit">
登録する
</button>


<small>
登録後、現在有効な常設ギフトコードも
順番に自動受取します。
</small>


<small>
ギフトコードの処理には
少し時間がかかる場合があります。
</small>


</form>


<div class="page-links">

<a href="/manage">
登録情報を確認・変更
</a>

</div>

</main>

</body>

</html>
`;

/* =========================================================
   MD5
========================================================= */

function md5(input) {

  function safeAdd(x, y) {

    const lsw =
      (x & 0xffff) +
      (y & 0xffff);

    const msw =
      (x >> 16) +
      (y >> 16) +
      (lsw >> 16);

    return (
      (msw << 16) |
      (lsw & 0xffff)
    );
  }


  function bitRotateLeft(
    num,
    cnt,
  ) {

    return (
      (num << cnt) |
      (num >>> (32 - cnt))
    );
  }


  function cmn(
    q,
    a,
    b,
    x,
    s,
    t,
  ) {

    return safeAdd(

      bitRotateLeft(

        safeAdd(

          safeAdd(
            a,
            q,
          ),

          safeAdd(
            x,
            t,
          ),
        ),

        s,
      ),

      b,
    );
  }


  function ff(
    a,
    b,
    c,
    d,
    x,
    s,
    t,
  ) {

    return cmn(
      (b & c) |
      (~b & d),
      a,
      b,
      x,
      s,
      t,
    );
  }


  function gg(
    a,
    b,
    c,
    d,
    x,
    s,
    t,
  ) {

    return cmn(
      (b & d) |
      (c & ~d),
      a,
      b,
      x,
      s,
      t,
    );
  }


  function hh(
    a,
    b,
    c,
    d,
    x,
    s,
    t,
  ) {

    return cmn(
      b ^ c ^ d,
      a,
      b,
      x,
      s,
      t,
    );
  }


  function ii(
    a,
    b,
    c,
    d,
    x,
    s,
    t,
  ) {

    return cmn(
      c ^ (b | ~d),
      a,
      b,
      x,
      s,
      t,
    );
  }


  function md5Cycle(
    state,
    block,
  ) {

    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];


    const oa = a;
    const ob = b;
    const oc = c;
    const od = d;


    a = ff(a,b,c,d,block[0],7,-680876936);
    d = ff(d,a,b,c,block[1],12,-389564586);
    c = ff(c,d,a,b,block[2],17,606105819);
    b = ff(b,c,d,a,block[3],22,-1044525330);

    a = ff(a,b,c,d,block[4],7,-176418897);
    d = ff(d,a,b,c,block[5],12,1200080426);
    c = ff(c,d,a,b,block[6],17,-1473231341);
    b = ff(b,c,d,a,block[7],22,-45705983);

    a = ff(a,b,c,d,block[8],7,1770035416);
    d = ff(d,a,b,c,block[9],12,-1958414417);
    c = ff(c,d,a,b,block[10],17,-42063);
    b = ff(b,c,d,a,block[11],22,-1990404162);

    a = ff(a,b,c,d,block[12],7,1804603682);
    d = ff(d,a,b,c,block[13],12,-40341101);
    c = ff(c,d,a,b,block[14],17,-1502002290);
    b = ff(b,c,d,a,block[15],22,1236535329);


    a = gg(a,b,c,d,block[1],5,-165796510);
    d = gg(d,a,b,c,block[6],9,-1069501632);
    c = gg(c,d,a,b,block[11],14,643717713);
    b = gg(b,c,d,a,block[0],20,-373897302);

    a = gg(a,b,c,d,block[5],5,-701558691);
    d = gg(d,a,b,c,block[10],9,38016083);
    c = gg(c,d,a,b,block[15],14,-660478335);
    b = gg(b,c,d,a,block[4],20,-405537848);

    a = gg(a,b,c,d,block[9],5,568446438);
    d = gg(d,a,b,c,block[14],9,-1019803690);
    c = gg(c,d,a,b,block[3],14,-187363961);
    b = gg(b,c,d,a,block[8],20,1163531501);

    a = gg(a,b,c,d,block[13],5,-1444681467);
    d = gg(d,a,b,c,block[2],9,-51403784);
    c = gg(c,d,a,b,block[7],14,1735328473);
    b = gg(b,c,d,a,block[12],20,-1926607734);


    a = hh(a,b,c,d,block[5],4,-378558);
    d = hh(d,a,b,c,block[8],11,-2022574463);
    c = hh(c,d,a,b,block[11],16,1839030562);
    b = hh(b,c,d,a,block[14],23,-35309556);

    a = hh(a,b,c,d,block[1],4,-1530992060);
    d = hh(d,a,b,c,block[4],11,1272893353);
    c = hh(c,d,a,b,block[7],16,-155497632);
    b = hh(b,c,d,a,block[10],23,-1094730640);

    a = hh(a,b,c,d,block[13],4,681279174);
    d = hh(d,a,b,c,block[0],11,-358537222);
    c = hh(c,d,a,b,block[3],16,-722521979);
    b = hh(b,c,d,a,block[6],23,76029189);

    a = hh(a,b,c,d,block[9],4,-640364487);
    d = hh(d,a,b,c,block[12],11,-421815835);
    c = hh(c,d,a,b,block[15],16,530742520);
    b = hh(b,c,d,a,block[2],23,-995338651);


    a = ii(a,b,c,d,block[0],6,-198630844);
    d = ii(d,a,b,c,block[7],10,1126891415);
    c = ii(c,d,a,b,block[14],15,-1416354905);
    b = ii(b,c,d,a,block[5],21,-57434055);

    a = ii(a,b,c,d,block[12],6,1700485571);
    d = ii(d,a,b,c,block[3],10,-1894986606);
    c = ii(c,d,a,b,block[10],15,-1051523);
    b = ii(b,c,d,a,block[1],21,-2054922799);

    a = ii(a,b,c,d,block[8],6,1873313359);
    d = ii(d,a,b,c,block[15],10,-30611744);
    c = ii(c,d,a,b,block[6],15,-1560198380);
    b = ii(b,c,d,a,block[13],21,1309151649);

    a = ii(a,b,c,d,block[4],6,-145523070);
    d = ii(d,a,b,c,block[11],10,-1120210379);
    c = ii(c,d,a,b,block[2],15,718787259);
    b = ii(b,c,d,a,block[9],21,-343485551);


    state[0] =
      safeAdd(a, oa);

    state[1] =
      safeAdd(b, ob);

    state[2] =
      safeAdd(c, oc);

    state[3] =
      safeAdd(d, od);
  }


  function md5Block(
    string,
  ) {

    const block =
      new Array(16)
        .fill(0);


    for (
      let i = 0;
      i < 64;
      i += 4
    ) {

      block[i >> 2] =

        string.charCodeAt(i) +

        (
          string.charCodeAt(i + 1)
          << 8
        ) +

        (
          string.charCodeAt(i + 2)
          << 16
        ) +

        (
          string.charCodeAt(i + 3)
          << 24
        );
    }


    return block;
  }


  /*
   * WOS署名で使用する文字列は
   * ASCIIだが、念のためUTF-8化。
   */
  const string =
    unescape(
      encodeURIComponent(
        String(input),
      ),
    );


  const state = [
    1732584193,
    -271733879,
    -1732584194,
    271733878,
  ];


  let index;


  for (
    index = 64;
    index <= string.length;
    index += 64
  ) {

    md5Cycle(

      state,

      md5Block(
        string.substring(
          index - 64,
          index,
        ),
      ),
    );
  }


  const tail =
    new Array(16)
      .fill(0);


  const remaining =
    string.substring(
      index - 64,
    );


  for (
    let i = 0;
    i < remaining.length;
    i++
  ) {

    tail[i >> 2] |=

      remaining.charCodeAt(i)
      << (
        (i % 4) << 3
      );
  }


  tail[
    remaining.length >> 2
  ] |=

    0x80
    << (
      (remaining.length % 4)
      << 3
    );


  if (
    remaining.length > 55
  ) {

    md5Cycle(
      state,
      tail,
    );


    for (
      let i = 0;
      i < 16;
      i++
    ) {

      tail[i] = 0;
    }
  }


  const bitLength =
    string.length * 8;


  tail[14] =
    bitLength & 0xffffffff;


  tail[15] =
    Math.floor(
      bitLength /
      0x100000000,
    );


  md5Cycle(
    state,
    tail,
  );


  function hex(
    number,
  ) {

    let result = "";


    for (
      let j = 0;
      j < 4;
      j++
    ) {

      result +=
        (
          "0" +
          (
            (
              number >>
              (j * 8)
            ) &
            0xff
          ).toString(16)
        ).slice(-2);
    }


    return result;
  }


  return (
    hex(state[0]) +
    hex(state[1]) +
    hex(state[2]) +
    hex(state[3])
  );
}
