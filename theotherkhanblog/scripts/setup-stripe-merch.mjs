#!/usr/bin/env node
// Create Stripe products, prices, shipping rates, and Payment Links
// for the Merch catalog. Each item has a free in-person pickup link
// and a paid shipping link. Checkout collects the buyer's name,
// address, and payment on Stripe's page.
//
// Usage, from the site root:
//   STRIPE_SECRET_KEY=sk_live_... node scripts/setup-stripe-merch.mjs
// or put STRIPE_SECRET_KEY in a .env file (that file is gitignored).
//
// Prices and the shipping amount live in .json. Edit them,
// then run this script again. Rebuild the site afterward so Hugo
// picks up the new Payment Link URLs.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = join(root, 'data', 'merch.json');
const stripeVersion = '2026-04-22.dahlia';

function loadEnv() {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function save(catalog) {
  writeFileSync(dataPath, JSON.stringify(catalog, null, 2) + '\n');
}

async function stripe(secret, method, path, params) {
  const headers = {
    Authorization: `Bearer ${secret}`,
    'Stripe-Version': stripeVersion,
  };
  let body;
  if (params) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        form.append(key, String(value));
      }
    }
    body = form;
  }
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { method, headers, body });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${json.error?.message || response.statusText}`);
  }
  return json;
}

function collectionParams(catalog, rateId) {
  const params = {
    'name_collection[individual][enabled]': 'true',
    'customer_creation': 'always',
    'billing_address_collection': 'auto',
    'after_completion[type]': 'redirect',
    'after_completion[redirect][url]': catalog.successUrl,
    'shipping_options[0][shipping_rate]': rateId,
  };
  catalog.allowedCountries.forEach((code, index) => {
    params[`shipping_address_collection[allowed_countries][${index}]`] = code;
  });
  return params;
}

async function ensureRate(secret, catalog, label, cents, currentId) {
  if (currentId) {
    const rate = await stripe(secret, 'GET', `shipping_rates/${currentId}`);
    const matches =
      rate.active &&
      rate.display_name === label &&
      rate.fixed_amount.amount === cents &&
      rate.fixed_amount.currency === catalog.currency;
    if (matches) return currentId;
  }
  const rate = await stripe(secret, 'POST', 'shipping_rates', {
    display_name: label,
    type: 'fixed_amount',
    'fixed_amount[amount]': cents,
    'fixed_amount[currency]': catalog.currency,
  });
  console.log(`${label}: ${rate.id} ($${(cents / 100).toFixed(2)})`);
  return rate.id;
}

async function ensurePaymentLink(secret, catalog, item, idKey, urlKey, rateId, fulfillment) {
  const shared = {
    ...collectionParams(catalog, rateId),
    'metadata[sku]': item.id,
    'metadata[fulfillment]': fulfillment,
  };
  if (item[idKey]) {
    try {
      await stripe(secret, 'POST', `payment_links/${item[idKey]}`, { ...shared, active: 'true' });
      console.log(`${item.name} (${fulfillment}): ${item[urlKey]}`);
      return;
    } catch (error) {
      console.log(`Replacing ${item.name} ${fulfillment} link: ${error.message}`);
      await stripe(secret, 'POST', `payment_links/${item[idKey]}`, { active: 'false' }).catch(() => {});
    }
  }
  const link = await stripe(secret, 'POST', 'payment_links', {
    ...shared,
    'line_items[0][price]': item.priceId,
    'line_items[0][quantity]': '1',
    'line_items[0][adjustable_quantity][enabled]': 'true',
    'line_items[0][adjustable_quantity][minimum]': '1',
    'line_items[0][adjustable_quantity][maximum]': '10',
  });
  item[idKey] = link.id;
  item[urlKey] = link.url;
  save(catalog);
  console.log(`${item.name} (${fulfillment}): ${link.url}`);
}

loadEnv();

const secret = process.env.STRIPE_SECRET_KEY || '';
if (!secret || secret.includes('replace_me')) {
  console.error('Set STRIPE_SECRET_KEY to your Stripe secret key, then run this script again.');
  process.exit(1);
}
if (secret.startsWith('pk_')) {
  console.error('That is a publishable key. Use the secret key, which starts with sk_test_ or sk_live_.');
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(dataPath, 'utf8'));
const mode = secret.includes('_test_') ? 'test' : 'live';
console.log(`Using Stripe ${mode} mode.`);

catalog.shippingRateId = await ensureRate(
  secret,
  catalog,
  catalog.shippingLabel || 'In-person pickup',
  catalog.shippingCents,
  catalog.shippingRateId,
);
catalog.deliveryRateId = await ensureRate(
  secret,
  catalog,
  catalog.deliveryLabel || 'Shipping',
  catalog.deliveryCents,
  catalog.deliveryRateId,
);
save(catalog);

for (const item of catalog.items) {
  if (!item.productId) {
    const product = await stripe(secret, 'POST', 'products', {
      name: item.name,
      description: item.description,
      'metadata[sku]': item.id,
    });
    item.productId = product.id;
    save(catalog);
    console.log(`Created product ${item.name}: ${product.id}`);
  } else {
    await stripe(secret, 'POST', `products/${item.productId}`, {
      name: item.name,
      description: item.description,
      'metadata[sku]': item.id,
    });
  }

  let priceMatches = false;
  if (item.priceId) {
    const price = await stripe(secret, 'GET', `prices/${item.priceId}`);
    priceMatches =
      price.active &&
      price.unit_amount === item.priceCents &&
      price.currency === catalog.currency;
  }
  if (!priceMatches) {
    const price = await stripe(secret, 'POST', 'prices', {
      product: item.productId,
      unit_amount: item.priceCents,
      currency: catalog.currency,
    });
    item.priceId = price.id;
    save(catalog);
    console.log(`Price for ${item.name}: ${price.id}`);
  }

  await ensurePaymentLink(
    secret,
    catalog,
    item,
    'paymentLinkId',
    'paymentLink',
    catalog.shippingRateId,
    'pickup',
  );
  await ensurePaymentLink(
    secret,
    catalog,
    item,
    'shipPaymentLinkId',
    'shipPaymentLink',
    catalog.deliveryRateId,
    'ship',
  );
}

console.log('Payment links are in .json. Rebuild the site so the Purchase buttons use them.');
