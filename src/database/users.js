import { pool } from "./pool.js";
import { isLanguage } from "../i18n/index.js";

// Writes to the `users` table: who the sender is, and what language we speak
// to them in. The workspace they are currently in lives in workspaces.js.

// Finds an existing Telegram user or creates a new one.
export async function findOrCreateUser(user) {
  const result = await pool.query(
    `
    INSERT INTO users (
      telegram_user_id,
      telegram_chat_id,
      first_name,
      username
    )
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (telegram_user_id)
    DO UPDATE SET
      telegram_chat_id = EXCLUDED.telegram_chat_id,
      first_name = EXCLUDED.first_name,
      username = EXCLUDED.username,
      updated_at = NOW()
    RETURNING *;
    `,
    [
      user.telegram_user_id,
      user.telegram_chat_id,
      user.first_name,
      user.username,
    ]
  );

  return result.rows[0];
}

// Sets the language the bot speaks to this user.
//
// NULL in this column means "has not chosen yet", which is what puts the
// picker in front of a new user before anything else. Once set it is only
// ever changed by /language or the picker, never inferred.
//
// isLanguage() is the whitelist. The column has a CHECK constraint too, but
// that would surface as a thrown error mid-callback; refusing here means a
// forged `lang:xx` from a patched Telegram client is a no-op that returns
// undefined, exactly like a forged workspace uuid above.
export async function setUserLanguage(userId, language) {
  if (!isLanguage(language)) return undefined;

  const result = await pool.query(
    `
    UPDATE users
    SET
      language = $2,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *;
    `,
    [userId, language]
  );

  return result.rows[0];
}
