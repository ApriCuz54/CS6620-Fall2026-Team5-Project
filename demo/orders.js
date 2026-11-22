// Order lookup for the storefront API.
export async function findOrders(db, customerId) {
  return db.query('SELECT * FROM orders WHERE customer_id = ?', [customerId]);
}

export function newOrderReference() {
  return 'ORD-' + Math.random().toString(36).slice(2, 10);
}
