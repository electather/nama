import { sql } from "drizzle-orm";

import type { PairingDatabase } from "./pairing-persistence-model-private.ts";
import { pairingApprovalResult, pairingRequest } from "./pairing-schema.ts";

const CLEANUP_BATCH_SIZE = 100;

type PairingExecutor = Pick<PairingDatabase, "execute">;

const lockPairingState = async (database: PairingExecutor): Promise<void> => {
  await database.execute(
    sql`select "key" from nama_server_state where "key" = 'server' for update`,
  );
};

const cleanupExpiredPairingRecords = async (database: PairingExecutor): Promise<void> => {
  await database.execute(sql`
    with expired_pairing_delivery as (
      select id
      from ${pairingRequest}
      where expires_at <= transaction_timestamp()
        and delivery_envelope_version is not null
      order by expires_at, created_at, id
      limit ${CLEANUP_BATCH_SIZE}
      for update skip locked
    )
    update ${pairingRequest} as request
    set delivery_envelope_version = null,
        delivery_credential_version = null,
        delivery_nonce = null,
        delivery_ciphertext = null,
        delivery_authentication_tag = null
    from expired_pairing_delivery as expired
    where request.id = expired.id
  `);
  await database.execute(sql`
    with expired_pairing_requests as (
      select id
      from ${pairingRequest}
      where retained_until <= transaction_timestamp()
      order by retained_until, created_at, id
      limit ${CLEANUP_BATCH_SIZE}
      for update skip locked
    )
    delete from ${pairingRequest} as request
    using expired_pairing_requests as expired
    where request.id = expired.id
  `);
  await database.execute(sql`
    with expired_pairing_approvals as (
      select administrator_user_id, method, operation_id
      from ${pairingApprovalResult}
      where expires_at <= transaction_timestamp()
      order by expires_at, created_at, operation_id
      limit ${CLEANUP_BATCH_SIZE}
      for update skip locked
    )
    delete from ${pairingApprovalResult} as result
    using expired_pairing_approvals as expired
    where result.administrator_user_id = expired.administrator_user_id
      and result.method = expired.method
      and result.operation_id = expired.operation_id
  `);
};

const cleanupExpiredPairings = (database: PairingDatabase): Promise<void> =>
  database.transaction(async (transaction) => {
    await lockPairingState(transaction);
    await cleanupExpiredPairingRecords(transaction);
  });

export {
  type PairingExecutor,
  cleanupExpiredPairingRecords,
  cleanupExpiredPairings,
  lockPairingState,
};
