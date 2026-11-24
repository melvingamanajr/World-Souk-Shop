export async function usingTransaction(client, work) {
  await client.query('BEGIN');
  try {
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function poolTransaction(pool, work) {
  const client = await pool.connect();
  try { return await usingTransaction(client, work); }
  finally { client.release(); }
}
