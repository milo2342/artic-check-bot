import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ChannelType,
} from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import http from "http";
import Stripe from "stripe";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const PAYMENTS_FILE = path.join(DATA_DIR, "payments.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const BLACK = 0x5865F2;
const BLUE = 0x5865F2;
const GREEN = 0x22c55e;
const RED = 0xef4444;
const YELLOW = 0xf59e0b;
const GREY = 0x6b7280;
const BRAND = "Artic Development";

const STATUS_META = {
  pending: { emoji: "⏳", label: "Awaiting payment", color: YELLOW },
  signed: { emoji: "📝", label: "Agreement signed", color: BLUE },
  paid: { emoji: "✅", label: "Paid", color: GREEN },
  voided: { emoji: "🚫", label: "Voided", color: GREY },
  refunded: { emoji: "↩️", label: "Refunded", color: GREY },
  disputed: { emoji: "⚠️", label: "Disputed", color: RED },
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    ensureDataDir();
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Failed to read ${path.basename(file)}:`, err);
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function loadPayments() { return readJson(PAYMENTS_FILE, []); }
function savePayments(value) { writeJson(PAYMENTS_FILE, value); }
function addPayment(value) { const all = loadPayments(); all.push(value); savePayments(all); return value; }
function updatePayment(id, changes) {
  const all = loadPayments();
  const idx = all.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...changes };
  savePayments(all);
  return all[idx];
}
function getPayment(id) { return loadPayments().find((p) => p.id === id) ?? null; }
function findPaymentByStripePaymentIntent(paymentIntentId) {
  return loadPayments().find((p) => p.stripePaymentIntentId === paymentIntentId) ?? null;
}
function findPaymentByStripeSubscription(subscriptionId) {
  return loadPayments().find((p) => p.stripeSubscriptionId === subscriptionId) ?? null;
}

function loadConfig() {
  return readJson(CONFIG_FILE, { ownerIds: [], guilds: {} });
}
function saveConfig(value) { writeJson(CONFIG_FILE, value); }
function guildConfig(guildId) {
  const cfg = loadConfig();
  if (!cfg.guilds[guildId]) cfg.guilds[guildId] = {};
  return cfg.guilds[guildId];
}
function saveGuildConfig(guildId, changes) {
  const cfg = loadConfig();
  cfg.guilds[guildId] = { ...(cfg.guilds[guildId] ?? {}), ...changes };
  saveConfig(cfg);
  return cfg.guilds[guildId];
}

const token = process.env.PAYMENT_BOT_TOKEN;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL ?? "https://discord.com/app";
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL ?? "https://discord.com/app";
const STRIPE_PORT = Number(process.env.STRIPE_WEBHOOK_PORT ?? process.env.PORT ?? 4242);
const BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? "";
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

if (!token) {
  console.error("PAYMENT_BOT_TOKEN is not set.");
  process.exit(1);
}

const configuredOwnerIds = () => {
  const ids = new Set((loadConfig().ownerIds ?? []).filter(Boolean));
  if (BOT_OWNER_ID) ids.add(BOT_OWNER_ID);
  return ids;
};
const isOwner = (id) => configuredOwnerIds().has(id);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

const commands = [
  new SlashCommandBuilder().setName("setup").setDescription("Check the Stripe payment configuration (owner only).").setDefaultMemberPermissions(0),
  new SlashCommandBuilder()
    .setName("invoice")
    .setDescription("Create a professional payment invoice.")
    .addUserOption((o) => o.setName("user").setDescription("The customer to invoice.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Main product/service name.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Main line item price in GBP.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("description").setDescription("Optional long description.").setRequired(false))
    .addStringOption((o) => o.setName("note").setDescription("Optional invoice note.").setRequired(false))
    .addStringOption((o) => o.setName("email").setDescription("Optional customer email for Stripe Checkout.").setRequired(false))
    .addNumberOption((o) => o.setName("discount").setDescription("Optional discount percentage (0-100).").setRequired(false).setMinValue(0).setMaxValue(100))
    .addIntegerOption((o) => o.setName("quantity").setDescription("Quantity of the main item.").setRequired(false).setMinValue(1).setMaxValue(99))
    .addBooleanOption((o) => o.setName("send_dm").setDescription("DM the customer the checkout link too.").setRequired(false))
    .addStringOption((o) => o.setName("item2").setDescription("Optional second line item.").setRequired(false))
    .addNumberOption((o) => o.setName("amount2").setDescription("Price of second line item.").setRequired(false).setMinValue(0.01))
    .addStringOption((o) => o.setName("item3").setDescription("Optional third line item.").setRequired(false))
    .addNumberOption((o) => o.setName("amount3").setDescription("Price of third line item.").setRequired(false).setMinValue(0.01))
    .addStringOption((o) => o.setName("item4").setDescription("Optional fourth line item.").setRequired(false))
    .addNumberOption((o) => o.setName("amount4").setDescription("Price of fourth line item.").setRequired(false).setMinValue(0.01))
    .addStringOption((o) => o.setName("item5").setDescription("Optional fifth line item.").setRequired(false))
    .addNumberOption((o) => o.setName("amount5").setDescription("Price of fifth line item.").setRequired(false).setMinValue(0.01)),
  new SlashCommandBuilder()
    .setName("subscription")
    .setDescription("Create a recurring subscription checkout.")
    .addUserOption((o) => o.setName("user").setDescription("The subscriber.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Subscription name.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Amount per interval in GBP.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("interval").setDescription("Billing interval.").setRequired(true).addChoices(
      { name: "Weekly", value: "Weekly" }, { name: "Monthly", value: "Monthly" }, { name: "Yearly", value: "Yearly" },
    ))
    .addStringOption((o) => o.setName("description").setDescription("Optional description.").setRequired(false))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .addStringOption((o) => o.setName("email").setDescription("Optional customer email.").setRequired(false))
    .addNumberOption((o) => o.setName("discount").setDescription("Optional first-payment discount percentage (0-100).").setRequired(false).setMinValue(0).setMaxValue(100))
    .addBooleanOption((o) => o.setName("send_dm").setDescription("DM the customer the checkout link too.").setRequired(false)),
  new SlashCommandBuilder()
    .setName("debt")
    .setDescription("Create an outstanding debt payment.")
    .addUserOption((o) => o.setName("user").setDescription("The customer who owes.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("What the debt is for.").setRequired(true))
    .addNumberOption((o) => o.setName("amount").setDescription("Total amount owed in GBP.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("due_date").setDescription("Due date.").setRequired(true))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .addStringOption((o) => o.setName("email").setDescription("Optional customer email.").setRequired(false))
    .addBooleanOption((o) => o.setName("send_dm").setDescription("DM the customer the checkout link too.").setRequired(false)),
  new SlashCommandBuilder()
    .setName("paylater")
    .setDescription("Create a deposit checkout with a later balance.")
    .addUserOption((o) => o.setName("user").setDescription("The customer paying.").setRequired(true))
    .addStringOption((o) => o.setName("product").setDescription("Product/service name.").setRequired(true))
    .addNumberOption((o) => o.setName("total").setDescription("Total price in GBP.").setRequired(true).setMinValue(0.01))
    .addNumberOption((o) => o.setName("deposit").setDescription("Deposit due now in GBP.").setRequired(true).setMinValue(0.01))
    .addStringOption((o) => o.setName("due_date").setDescription("Remaining balance due date.").setRequired(true))
    .addStringOption((o) => o.setName("note").setDescription("Optional note.").setRequired(false))
    .addStringOption((o) => o.setName("email").setDescription("Optional customer email.").setRequired(false))
    .addBooleanOption((o) => o.setName("send_dm").setDescription("DM the customer the checkout link too.").setRequired(false)),
  new SlashCommandBuilder().setName("invoice-status").setDescription("Check an invoice's current status.").addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(true)),
  new SlashCommandBuilder().setName("invoice-details").setDescription("View full invoice details.").addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(true)),
  new SlashCommandBuilder().setName("invoice-history").setDescription("View payment history for a customer (owner only).").setDefaultMemberPermissions(0).addUserOption((o) => o.setName("user").setDescription("Customer.").setRequired(true)),
  new SlashCommandBuilder().setName("invoice-resend").setDescription("Generate a fresh Stripe checkout and resend it (owner only).").setDefaultMemberPermissions(0).addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(true)).addBooleanOption((o) => o.setName("send_dm").setDescription("DM the customer the new checkout.").setRequired(false)),
  new SlashCommandBuilder().setName("invoice-cancel").setDescription("Cancel/void an invoice (owner only).").setDefaultMemberPermissions(0).addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("Cancellation reason.").setRequired(false)),
  new SlashCommandBuilder().setName("refund").setDescription("Issue a Stripe refund (owner only).").setDefaultMemberPermissions(0).addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(true)).addNumberOption((o) => o.setName("amount").setDescription("Optional partial refund in GBP.").setRequired(false).setMinValue(0.01)).addStringOption((o) => o.setName("reason").setDescription("Refund reason.").setRequired(false)),
  new SlashCommandBuilder().setName("payment-lookup").setDescription("Look up a Stripe payment/invoice.").addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(false)).addStringOption((o) => o.setName("stripe_payment_id").setDescription("Stripe PaymentIntent ID.").setRequired(false)),
  new SlashCommandBuilder().setName("payment-history").setDescription("View recent payment activity (owner only).").setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName("receipt").setDescription("Retrieve the Stripe receipt for an invoice.").addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(true)),
  new SlashCommandBuilder().setName("customer").setDescription("View or update a customer's billing profile.").addSubcommand((s) => s.setName("view").setDescription("View a customer's payment history.").addUserOption((o) => o.setName("user").setDescription("Customer.").setRequired(true))).addSubcommand((s) => s.setName("set").setDescription("Set the customer's billing email.").addUserOption((o) => o.setName("user").setDescription("Customer.").setRequired(true)).addStringOption((o) => o.setName("email").setDescription("Billing email.").setRequired(true))),
  new SlashCommandBuilder().setName("subscription-cancel").setDescription("Cancel a Stripe subscription (owner only).").setDefaultMemberPermissions(0).addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(true)),
  new SlashCommandBuilder().setName("balance").setDescription("Show your Stripe balance (owner only).").setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName("remind").setDescription("Send a payment reminder to a customer (owner only).").setDefaultMemberPermissions(0).addStringOption((o) => o.setName("invoice_id").setDescription("Invoice ID.").setRequired(true)).addStringOption((o) => o.setName("message").setDescription("Optional custom message.").setRequired(false)),
  new SlashCommandBuilder().setName("agreements").setDescription("View signed agreements (owner only).").setDefaultMemberPermissions(0),
  new SlashCommandBuilder().setName("payment-log").setDescription("Set the payment/dispute log channel (owner only).").setDefaultMemberPermissions(0).addChannelOption((o) => o.setName("channel").setDescription("Channel for payment and dispute logs.").addChannelTypes(ChannelType.GuildText).setRequired(true)),
  new SlashCommandBuilder().setName("credit").setDescription("View the bot Developer."),
].map((cmd) => cmd.setIntegrationTypes?.([0, 1]).setContexts?.([0, 1, 2]).toJSON?.() ?? cmd.toJSON());

client.once(Events.ClientReady, async (readyClient) => {
  const rest = new REST({ version: "10" }).setToken(token);
  console.log(`${BRAND} logged in as ${readyClient.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
    console.log(`Slash commands registered: ${commands.length}`);
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
  startStripeWebhookServer();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isModalSubmit()) return await handleModal(interaction);
  } catch (err) {
    console.error("Interaction error:", err);
    await safeInteractionError(interaction, err);
  }
});

async function safeInteractionError(interaction, err) {
  const detail = formatStripeError(err);
  try {
    if (interaction.deferred) await interaction.editReply({ content: `❌ **Something went wrong.**\n${detail}` });
    else if (interaction.replied) await interaction.followUp({ content: `❌ **Something went wrong.**\n${detail}`, ephemeral: true });
    else await interaction.reply({ content: `❌ **Something went wrong.**\n${detail}`, ephemeral: true });
  } catch {}
}

function formatStripeError(err) {
  if (err?.type?.startsWith?.("Stripe") || err?.raw?.message) return `Stripe: ${err.raw?.message ?? err.message}`.slice(0, 1800);
  return String(err?.message ?? err).slice(0, 1800);
}

function generateInvoiceNumber() {
  const date = new Date();
  const stamp = [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("");
  let number = `INV-${stamp}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const existing = new Set(loadPayments().map((p) => p.invoiceNumber));
  while (existing.has(number)) number = `INV-${stamp}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  return number;
}

function buildItemsFromOptions(interaction) {
  const items = [{
    name: interaction.options.getString("product", true).trim(),
    amount: interaction.options.getNumber("amount", true),
    quantity: interaction.options.getInteger("quantity") ?? 1,
  }];
  for (let i = 2; i <= 5; i++) {
    const name = interaction.options.getString(`item${i}`)?.trim();
    const amount = interaction.options.getNumber(`amount${i}`);
    if (name && Number.isFinite(amount) && amount > 0) items.push({ name, amount, quantity: 1 });
    if ((name && !amount) || (!name && amount)) throw new Error(`Both item${i} and amount${i} must be provided together.`);
  }
  return items;
}

function calculateSubtotal(items) { return items.reduce((sum, item) => sum + item.amount * item.quantity, 0); }

function buildPaymentEmbed(payment, mode = "created") {
  const status = STATUS_META[payment.status] ?? STATUS_META.pending;
  const displayTotal = payment.totalBeforeDiscount ?? payment.amount;
  const discounted = payment.discountPercent ? payment.discountedSubtotal : null;
  const action = payment.type === "subscription" ? "Subscription" : payment.type === "paylater" ? "Pay Later" : payment.type === "debt" ? "Debt" : "Invoice";
  const description = mode === "paid" ? `✅ **Payment received successfully.**\nYour records have been updated.` : mode === "dispute" ? `⚠️ **Stripe has reported a dispute on this payment.**` : mode === "failed" ? `❌ **Stripe reported a payment failure.**` : mode === "expired" ? `⌛ **This checkout session has expired.**` : mode === "refunded" ? `↩️ **This payment has been refunded.**` : payment.description ? payment.description : `Secure payment request created through ${BRAND}.`;

  const embed = new EmbedBuilder()
    .setColor(BLACK)
    .setTitle(`${BRAND}  •  ${action.toUpperCase()}`)
    .setDescription(`**${payment.product}**\n${description}`)
    .addFields(
      { name: "Customer", value: `<@${payment.targetUserId}>`, inline: true },
      { name: "Issued By", value: `<@${payment.createdBy}>`, inline: true },
      { name: "Status", value: `${status.emoji} **${status.label}**`, inline: true },
      { name: "Invoice", value: `
\`${payment.invoiceNumber}\``, inline: true },
      { name: payment.type === "subscription" ? "Recurring" : "Total", value: payment.type === "subscription" ? `£${payment.amount.toFixed(2)} / ${payment.interval}` : `£${displayTotal.toFixed(2)}`, inline: true },
      { name: "Payment", value: payment.stripeUrl ? `[Open Stripe Checkout](${payment.stripeUrl})` : "Stripe checkout unavailable", inline: true },
    );

  if (discounted != null && payment.discountPercent > 0) embed.addFields({ name: "Discount", value: `${payment.discountPercent}% off • £${payment.discountedSubtotal.toFixed(2)}`, inline: true });
  if (payment.type === "paylater") embed.addFields({ name: "Balance Due Later", value: `£${payment.remaining.toFixed(2)} • Due ${payment.dueDate}`, inline: true });
  if (payment.type === "debt") embed.addFields({ name: "Due Date", value: payment.dueDate, inline: true });
  if (payment.type === "subscription" && payment.stripeSubscriptionId) embed.addFields({ name: "Subscription", value: `\`${payment.stripeSubscriptionId}\``, inline: false });
  if (payment.note) embed.addFields({ name: "Note", value: payment.note.slice(0, 1024), inline: false });
  if (payment.disputeStatus) embed.addFields({ name: "Dispute", value: `⚠️ **${payment.disputeStatus.toUpperCase()}**${payment.disputeReason ? ` • ${payment.disputeReason}` : ""}`, inline: false });
  if (payment.paidAt) embed.addFields({ name: "Paid At", value: `<t:${Math.floor(new Date(payment.paidAt).getTime() / 1000)}:F>`, inline: true });

  embed.setFooter({ text: `Automatic tax + 3D Secure enabled • ${BRAND}` }).setTimestamp(new Date(payment.paidAt ?? payment.createdAt));
  return embed;
}

function buildInvoiceLineSummary(payment) {
  return (payment.items ?? [{ name: payment.product, amount: payment.amount, quantity: 1 }])
    .map((item) => `• ${item.quantity}× ${item.name} — £${(item.amount * item.quantity).toFixed(2)}`)
    .join("\n");
}

function buildPayButton(paymentId, checkoutUrl) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("Pay securely with Stripe").setStyle(ButtonStyle.Link).setURL(checkoutUrl),
  );
}

function buildAgreementButton(paymentId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sign_${paymentId}`).setLabel("Sign Agreement").setStyle(ButtonStyle.Success).setEmoji("✍️"),
  );
}

async function handleCommand(interaction) {
  const { commandName, user } = interaction;

  if (commandName === "setup") return handleSetup(interaction);
  if (commandName === "invoice") return handleInvoice(interaction);
  if (commandName === "subscription") return handleSubscription(interaction);
  if (commandName === "debt") return handleDebt(interaction);
  if (commandName === "paylater") return handlePayLater(interaction);
  if (commandName === "invoice-status") return handleInvoiceStatus(interaction);
  if (commandName === "invoice-details") return handleInvoiceDetails(interaction);
  if (commandName === "invoice-history") return handleInvoiceHistory(interaction);
  if (commandName === "invoice-resend") return handleInvoiceResend(interaction);
  if (commandName === "invoice-cancel") return handleInvoiceCancel(interaction);
  if (commandName === "refund") return handleRefund(interaction);
  if (commandName === "payment-lookup") return handlePaymentLookup(interaction);
  if (commandName === "payment-history") return handlePaymentHistory(interaction);
  if (commandName === "receipt") return handleReceipt(interaction);
  if (commandName === "customer") return handleCustomer(interaction);
  if (commandName === "subscription-cancel") return handleSubscriptionCancel(interaction);
  if (commandName === "balance") return handleBalance(interaction);
  if (commandName === "remind") return handleReminder(interaction);
  if (commandName === "agreements") return handleAgreements(interaction);
  if (commandName === "payment-log") return handlePaymentLog(interaction);
  if (commandName === "credit") return handlecredit(interaction);
}

async function handleSetup(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can run `/setup`.", ephemeral: true });
  const missing = [];
  if (!STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  const embed = new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  Configuration`).setDescription(missing.length ? `❌ Missing: ${missing.join(", ")}` : "✅ Stripe is configured and ready.")
    .addFields(
      { name: "Terms of Service", value: "Uses the Terms URL configured in Stripe Dashboard.", inline: true },
      { name: "3D Secure", value: "Enabled for card Checkout requests.", inline: true },
      { name: "Stripe Tax", value: "Automatic tax enabled on Checkout.", inline: true },
      { name: "Webhook", value: STRIPE_WEBHOOK_SECRET ? "✅ Configured" : "❌ Missing", inline: true },
    ).setFooter({ text: BRAND }).setTimestamp();
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function createPaymentRecord(interaction, base) {
  const id = randomUUID().slice(0, 8);
  const invoiceNumber = generateInvoiceNumber();
  const payment = {
    id,
    invoiceNumber,
    guildId: interaction.guildId ?? null,
    discordChannelId: null,
    discordMessageId: null,
    type: base.type,
    createdBy: interaction.user.id,
    createdByTag: interaction.user.tag,
    targetUserId: base.target.id,
    targetUserTag: base.target.tag,
    product: base.product,
    description: base.description ?? null,
    note: base.note ?? null,
    email: base.email ?? guildConfig(interaction.guildId ?? "").customerEmails?.[base.target.id] ?? null,
    amount: base.amount,
    totalBeforeDiscount: base.totalBeforeDiscount ?? base.amount,
    discountedSubtotal: base.discountedSubtotal ?? null,
    discountPercent: base.discountPercent ?? 0,
    items: base.items ?? [{ name: base.product, amount: base.amount, quantity: 1 }],
    interval: base.interval ?? null,
    dueDate: base.dueDate ?? null,
    deposit: base.deposit ?? null,
    remaining: base.remaining ?? null,
    status: "pending",
    createdAt: new Date().toISOString(),
    sendDm: Boolean(base.sendDm),
    resendCount: 0,
    taxEnabled: true,
    threeDSecure: "any",
    stripeTaxEnabled: true,
  };
  const checkout = await createStripeCheckout(payment);
  payment.stripeCheckoutSessionId = checkout.id;
  payment.stripeUrl = checkout.url;
  addPayment(payment);
  return payment;
}

async function finishInvoiceCreation(interaction, payment, title = "Invoice Created") {
  const embed = buildPaymentEmbed(payment);
  embed.setTitle(`${BRAND}  •  ${title.toUpperCase()}`).addFields({ name: "Items", value: buildInvoiceLineSummary(payment), inline: false });
  if (payment.description) embed.addFields({ name: "Description", value: payment.description.slice(0, 1024), inline: false });
  if (payment.sendDm) {
    try {
      const target = await client.users.fetch(payment.targetUserId);
      await target.send({ embeds: [embed], components: [buildPayButton(payment.id, payment.stripeUrl), buildAgreementButton(payment.id)] });
    } catch {
      // DM failures are non-fatal.
    }
  }
  const sent = await interaction.editReply({ content: `<@${payment.targetUserId}>`, embeds: [embed], components: [buildPayButton(payment.id, payment.stripeUrl), buildAgreementButton(payment.id)] });
  updatePayment(payment.id, { discordChannelId: sent.channel?.id ?? null, discordMessageId: sent.id });
  await sendPaymentLog(payment.guildId, buildPaymentEmbed(payment));
}

async function handleInvoice(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser("user", true);
  const items = buildItemsFromOptions(interaction);
  const totalBeforeDiscount = calculateSubtotal(items);
  const discountPercent = interaction.options.getNumber("discount") ?? 0;
  const discountedSubtotal = parseFloat((totalBeforeDiscount * (1 - discountPercent / 100)).toFixed(2));
  if (discountedSubtotal <= 0) return interaction.editReply({ content: "❌ Discount leaves the invoice at £0.00. Use a smaller discount." });
  const payment = await createPaymentRecord(interaction, {
    type: "invoice",
    target,
    product: items[0].name,
    amount: discountedSubtotal,
    totalBeforeDiscount,
    discountedSubtotal,
    discountPercent,
    items,
    description: interaction.options.getString("description"),
    note: interaction.options.getString("note"),
    email: interaction.options.getString("email") ?? null,
    sendDm: interaction.options.getBoolean("send_dm") ?? false,
  });
  return finishInvoiceCreation(interaction, payment, "Invoice Created");
}

async function handleSubscription(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getNumber("amount", true);
  const interval = interaction.options.getString("interval", true);
  const discountPercent = interaction.options.getNumber("discount") ?? 0;
  const discountedAmount = parseFloat((amount * (1 - discountPercent / 100)).toFixed(2));
  if (discountedAmount <= 0) return interaction.editReply({ content: "❌ Discount leaves the subscription at £0.00." });
  const payment = await createPaymentRecord(interaction, {
    type: "subscription",
    target,
    product: interaction.options.getString("product", true).trim(),
    amount: discountedAmount,
    totalBeforeDiscount: amount,
    discountedSubtotal: discountedAmount,
    discountPercent,
    interval,
    description: interaction.options.getString("description"),
    note: interaction.options.getString("note"),
    email: interaction.options.getString("email") ?? null,
    sendDm: interaction.options.getBoolean("send_dm") ?? false,
  });
  return finishInvoiceCreation(interaction, payment, "Subscription Created");
}

async function handleDebt(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser("user", true);
  const payment = await createPaymentRecord(interaction, {
    type: "debt",
    target,
    product: interaction.options.getString("product", true).trim(),
    amount: interaction.options.getNumber("amount", true),
    dueDate: interaction.options.getString("due_date", true).trim(),
    note: interaction.options.getString("note")?.trim() ?? null,
    email: interaction.options.getString("email")?.trim() ?? null,
    sendDm: interaction.options.getBoolean("send_dm") ?? false,
  });
  return finishInvoiceCreation(interaction, payment, "Debt Checkout Created");
}

async function handlePayLater(interaction) {
  await interaction.deferReply();
  const target = interaction.options.getUser("user", true);
  const total = interaction.options.getNumber("total", true);
  const deposit = interaction.options.getNumber("deposit", true);
  if (deposit >= total) return interaction.editReply({ content: "❌ The deposit must be less than the total." });
  const remaining = parseFloat((total - deposit).toFixed(2));
  const payment = await createPaymentRecord(interaction, {
    type: "paylater",
    target,
    product: interaction.options.getString("product", true).trim(),
    amount: deposit,
    totalBeforeDiscount: total,
    deposit,
    remaining,
    dueDate: interaction.options.getString("due_date", true).trim(),
    note: interaction.options.getString("note")?.trim() ?? null,
    email: interaction.options.getString("email")?.trim() ?? null,
    sendDm: interaction.options.getBoolean("send_dm") ?? false,
  });
  return finishInvoiceCreation(interaction, payment, "Pay Later Checkout Created");
}

async function handleInvoiceStatus(interaction) {
  const payment = getPayment(interaction.options.getString("invoice_id", true));
  if (!payment) return interaction.reply({ content: "❌ Invoice not found.", ephemeral: true });
  await interaction.reply({ embeds: [buildPaymentEmbed(payment)], ephemeral: true });
}

async function handleInvoiceDetails(interaction) {
  const payment = getPayment(interaction.options.getString("invoice_id", true));
  if (!payment) return interaction.reply({ content: "❌ Invoice not found.", ephemeral: true });
  const embed = buildPaymentEmbed(payment).addFields({ name: "Line Items", value: buildInvoiceLineSummary(payment), inline: false });
  if (payment.signedName) embed.addFields({ name: "Agreement", value: `Signed by **${payment.signedName}** at <t:${Math.floor(new Date(payment.signedAt).getTime() / 1000)}:F>`, inline: false });
  if (payment.stripePaymentIntentId) embed.addFields({ name: "Stripe PaymentIntent", value: `\`${payment.stripePaymentIntentId}\``, inline: false });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleInvoiceHistory(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can view invoice history.", ephemeral: true });
  const target = interaction.options.getUser("user", true);
  const all = loadPayments().filter((p) => p.targetUserId === target.id).slice(-20).reverse();
  if (!all.length) return interaction.reply({ content: `No invoices found for ${target}.`, ephemeral: true });
  const lines = all.map((p) => `${STATUS_META[p.status]?.emoji ?? "❔"} \`${p.invoiceNumber}\` • ${p.product} • £${p.amount.toFixed(2)} • ${STATUS_META[p.status]?.label ?? p.status}`);
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  CUSTOMER HISTORY`).setDescription(lines.join("\n")).setFooter({ text: `${all.length} recent record(s)` }).setTimestamp()], ephemeral: true });
}

async function handleInvoiceResend(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can resend invoices.", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const id = interaction.options.getString("invoice_id", true);
  const payment = getPayment(id);
  if (!payment) return interaction.editReply({ content: "❌ Invoice not found." });
  if (["paid", "refunded", "voided"].includes(payment.status)) return interaction.editReply({ content: `❌ This invoice is **${payment.status}** and cannot be resent.` });
  if (stripe && payment.stripeCheckoutSessionId) {
    await stripe.checkout.sessions.expire(payment.stripeCheckoutSessionId).catch(() => null);
  }
  const checkout = await createStripeCheckout({ ...payment, resend: true });
  const updated = updatePayment(id, { stripeCheckoutSessionId: checkout.id, stripeUrl: checkout.url, resendCount: (payment.resendCount ?? 0) + 1 });
  const sendDm = interaction.options.getBoolean("send_dm") ?? false;
  const components = [buildPayButton(id, checkout.url), buildAgreementButton(id)];
  if (sendDm) {
    try { const target = await client.users.fetch(payment.targetUserId); await target.send({ embeds: [buildPaymentEmbed(updated)], components }); } catch {}
  }
  await interaction.editReply({ content: `✅ New checkout created for \`${payment.invoiceNumber}\`.\n${checkout.url}` });
}

async function handleInvoiceCancel(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can cancel invoices.", ephemeral: true });
  const id = interaction.options.getString("invoice_id", true);
  const reason = interaction.options.getString("reason")?.trim() ?? "No reason provided.";
  const payment = getPayment(id);
  if (!payment) return interaction.reply({ content: "❌ Invoice not found.", ephemeral: true });
  if (["paid", "refunded"].includes(payment.status)) return interaction.reply({ content: "❌ Paid/refunded invoices cannot be voided.", ephemeral: true });
  if (stripe && payment.stripeCheckoutSessionId) {
    await stripe.checkout.sessions.expire(payment.stripeCheckoutSessionId).catch(() => null);
  }
  updatePayment(id, { status: "voided", voidReason: reason, voidedAt: new Date().toISOString() });
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  INVOICE VOIDED`).setDescription(`\`${payment.invoiceNumber}\` has been voided.`).addFields({ name: "Reason", value: reason }).setFooter({ text: BRAND }).setTimestamp()] });
  try { const target = await client.users.fetch(payment.targetUserId); await target.send(`🚫 Your invoice **${payment.invoiceNumber}** has been voided.\nReason: ${reason}`); } catch {}
}

async function handleRefund(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can issue refunds.", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  if (!stripe) return interaction.editReply({ content: "❌ Stripe is not configured." });
  const payment = getPayment(interaction.options.getString("invoice_id", true));
  if (!payment) return interaction.editReply({ content: "❌ Invoice not found." });
  if (!payment.stripePaymentIntentId) return interaction.editReply({ content: "❌ This invoice has no successful Stripe PaymentIntent to refund." });
  const amount = interaction.options.getNumber("amount");
  const reason = interaction.options.getString("reason") ?? "Requested by merchant";
  const refund = await stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId, ...(amount ? { amount: Math.round(amount * 100) } : {}) });
  const fullRefund = !amount || amount >= payment.amount;
  const updated = updatePayment(payment.id, { status: fullRefund ? "refunded" : "paid", refundId: refund.id, refundedAmount: amount ?? payment.amount, refundReason: reason, refundedAt: new Date().toISOString() });
  await refreshDiscordPaymentMessage(updated, "refunded");
  await sendPaymentLog(payment.guildId, buildPaymentEmbed(updated, "refunded"));
  await interaction.editReply({ content: `✅ Refund created: **£${((refund.amount ?? 0) / 100).toFixed(2)}** • \`${refund.id}\`` });
}

async function handlePaymentLookup(interaction) {
  const invoiceId = interaction.options.getString("invoice_id");
  const pi = interaction.options.getString("stripe_payment_id");
  let payment = invoiceId ? getPayment(invoiceId) : null;
  if (!payment && pi) payment = findPaymentByStripePaymentIntent(pi);
  if (!payment) return interaction.reply({ content: "❌ Payment record not found.", ephemeral: true });
  await interaction.reply({ embeds: [buildPaymentEmbed(payment)], ephemeral: true });
}

async function handlePaymentHistory(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can view payment history.", ephemeral: true });
  const all = loadPayments().slice(-25).reverse();
  if (!all.length) return interaction.reply({ content: "No payment records yet.", ephemeral: true });
  const lines = all.map((p) => `${STATUS_META[p.status]?.emoji ?? "❔"} **${p.invoiceNumber}** • <@${p.targetUserId}> • £${p.amount.toFixed(2)} • ${STATUS_META[p.status]?.label ?? p.status}`);
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  PAYMENT HISTORY`).setDescription(lines.join("\n")).setFooter({ text: `${all.length} recent transactions` }).setTimestamp()], ephemeral: true });
}

async function handleReceipt(interaction) {
  if (!stripe) return interaction.reply({ content: "❌ Stripe is not configured.", ephemeral: true });
  const payment = getPayment(interaction.options.getString("invoice_id", true));
  if (!payment?.stripePaymentIntentId) return interaction.reply({ content: "❌ No successful Stripe payment exists for this invoice yet.", ephemeral: true });
  const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId, { expand: ["latest_charge"] });
  const receiptUrl = intent.latest_charge?.receipt_url;
  if (!receiptUrl) return interaction.reply({ content: "❌ Stripe has not generated a receipt URL for this payment yet.", ephemeral: true });
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  RECEIPT`).setDescription(`[Open the Stripe receipt](${receiptUrl})`).addFields({ name: "Invoice", value: `\`${payment.invoiceNumber}\``, inline: true }, { name: "Amount", value: `£${payment.amount.toFixed(2)}`, inline: true }).setTimestamp()], ephemeral: true });
}

async function handleCustomer(interaction) {
  const sub = interaction.options.getSubcommand();
  const target = interaction.options.getUser("user", true);
  const all = loadPayments().filter((p) => p.targetUserId === target.id);
  const cfg = interaction.guildId ? guildConfig(interaction.guildId) : {};
  if (sub === "set") {
    if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can update customer billing profiles.", ephemeral: true });
    const email = interaction.options.getString("email", true).trim();
    if (interaction.guildId) saveGuildConfig(interaction.guildId, { customerEmails: { ...(cfg.customerEmails ?? {}), [target.id]: email } });
    return interaction.reply({ content: "✅ Saved billing email for **" + target.tag + "**: `" + email + "`", ephemeral: true });
  }
  const email = cfg.customerEmails?.[target.id] ?? all.find((p) => p.email)?.email ?? "Not set";
  const total = all.reduce((sum, p) => sum + (p.status === "paid" ? p.amount : 0), 0);
  const embed = new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  CUSTOMER`).setDescription(`**${target.tag}**\nBilling profile and recent payment activity.`).addFields(
    { name: "Billing Email", value: email, inline: true },
    { name: "Invoices", value: String(all.length), inline: true },
    { name: "Paid Total", value: `£${total.toFixed(2)}`, inline: true },
  );
  if (all.length) embed.addFields({ name: "Recent", value: all.slice(-8).reverse().map((p) => `${STATUS_META[p.status]?.emoji ?? "❔"} ${p.invoiceNumber} • £${p.amount.toFixed(2)}`).join("\n"), inline: false });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleSubscriptionCancel(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can cancel subscriptions.", ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  if (!stripe) return interaction.editReply({ content: "❌ Stripe is not configured." });
  const payment = getPayment(interaction.options.getString("invoice_id", true));
  if (!payment?.stripeSubscriptionId) return interaction.editReply({ content: "❌ No Stripe subscription is attached to this invoice." });
  const sub = await stripe.subscriptions.cancel(payment.stripeSubscriptionId);
  updatePayment(payment.id, { subscriptionStatus: sub.status, subscriptionCancelledAt: new Date().toISOString() });
  await interaction.editReply({ content: `✅ Subscription \`${payment.stripeSubscriptionId}\` cancelled.` });
}

async function handleBalance(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can view the Stripe balance.", ephemeral: true });
  if (!stripe) return interaction.reply({ content: "❌ Stripe is not configured.", ephemeral: true });
  const balance = await stripe.balance.retrieve();
  const lines = [];
  for (const item of balance.available ?? []) lines.push(`✅ Available: **${formatStripeMoney(item.amount, item.currency)}**`);
  for (const item of balance.pending ?? []) lines.push(`⏳ Pending: **${formatStripeMoney(item.amount, item.currency)}**`);
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  STRIPE BALANCE`).setDescription(lines.join("\n") || "No balance data.").setFooter({ text: BRAND }).setTimestamp()] });
}

function formatStripeMoney(amountMinor, currency) {
  const code = String(currency).toUpperCase();
  if (code === "GBP") return `£${(amountMinor / 100).toFixed(2)}`;
  return `${code} ${(amountMinor / 100).toFixed(2)}`;
}

async function handleReminder(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can send reminders.", ephemeral: true });
  const payment = getPayment(interaction.options.getString("invoice_id", true));
  if (!payment) return interaction.reply({ content: "❌ Invoice not found.", ephemeral: true });
  if (["paid", "refunded", "voided"].includes(payment.status)) return interaction.reply({ content: `❌ This invoice is already **${payment.status}**.`, ephemeral: true });
  if (!stripe) return interaction.reply({ content: "❌ Stripe is not configured.", ephemeral: true });
  const checkout = await createStripeCheckout({ ...payment, reminder: true });
  updatePayment(payment.id, { stripeCheckoutSessionId: checkout.id, stripeUrl: checkout.url });
  const amountDue = payment.type === "paylater" ? payment.remaining : payment.amount;
  try {
    const target = await client.users.fetch(payment.targetUserId);
    const custom = interaction.options.getString("message")?.trim();
    await target.send(`⏰ **Payment Reminder — ${payment.invoiceNumber}**\n${payment.product}\nAmount due: **£${amountDue.toFixed(2)}**\nPay securely: ${checkout.url}${custom ? `\n\n${custom}` : ""}`);
    await interaction.reply({ content: `✅ Reminder sent to **${target.tag}**.`, ephemeral: true });
  } catch {
    await interaction.reply({ content: "❌ Could not DM the customer. Their DMs may be closed.", ephemeral: true });
  }
}

async function handleAgreements(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can view agreements.", ephemeral: true });
  const signed = loadPayments().filter((p) => p.status === "signed" || p.paidAt).slice(-15).reverse();
  if (!signed.length) return interaction.reply({ content: "No signed agreements yet.", ephemeral: true });
  const embed = new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  SIGNED AGREEMENTS`).setDescription(signed.map((p) => `✅ **${p.invoiceNumber}** • ${p.product} • <@${p.targetUserId}>${p.signedName ? ` • Signed by **${p.signedName}**` : ""}`).join("\n")).setFooter({ text: "Agreement records are stored locally by the bot." }).setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handlePaymentLog(interaction) {
  if (!isOwner(interaction.user.id)) return interaction.reply({ content: "Only the bot owner can configure payment logs.", ephemeral: true });
  if (!interaction.guildId) return interaction.reply({ content: "This command must be used in a server.", ephemeral: true });
  const channel = interaction.options.getChannel("channel", true);
  saveGuildConfig(interaction.guildId, { paymentLogChannelId: channel.id });
  await interaction.reply({ content: `✅ Payment and dispute logs will be sent to ${channel}.`, ephemeral: true });
}

async function sendPaymentLog(guildId, embed) {
  if (!guildId) return;
  const channelId = guildConfig(guildId).paymentLogChannelId;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased()) await channel.send({ embeds: [embed] }).catch(() => null);
}

async function handlecredit(interaction) {
  const embed = new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  credits`).setDescription([
    "**Bot Development credits**This bot was fully designed and developed by **@teo.dev_** through **Artic Development**. I built the system from the ground up, including the Discord commands, payment and checkout system,Stripe integration, automated embeds, logs, permissions, customer agreements, fraud/3D Secure support, and the various management features.A lot of time went into making the bot reliable, professional, and easy to use while keeping it customizable for different servers and businesses.**Developer:** @teo.dev_**Development Server:** https://discord.gg/Xmu9B4NcGW**Artic Development** — Custom Discord Bot Development & Systems",
  
  ].join("\n\n")).setFooter({ text: `${BRAND} • Titan Development` }).setTimestamp();
  await interaction.reply({ embeds: [embed] });
}

async function handleButton(interaction) {
  if (!interaction.customId.startsWith("sign_")) return;
  const paymentId = interaction.customId.slice(5);
  const payment = getPayment(paymentId);
  if (!payment) return interaction.reply({ content: "❌ This invoice no longer exists.", ephemeral: true });
  if (payment.status === "voided") return interaction.reply({ content: "❌ This invoice has been voided.", ephemeral: true });
  if (payment.signedAt) return interaction.reply({ content: "✅ This agreement has already been signed.", ephemeral: true });
  if (interaction.user.id !== payment.targetUserId) return interaction.reply({ content: "Only the invoiced customer can sign this agreement.", ephemeral: true });

  const modal = new ModalBuilder().setCustomId(`modal_sign_${paymentId}`).setTitle("Sign Payment Agreement");
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("agreement_preview").setLabel("Agreement (read carefully)").setStyle(TextInputStyle.Paragraph).setValue(buildAgreementText(payment)).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("legal_name").setLabel("Your Full Legal Name").setStyle(TextInputStyle.Short).setPlaceholder("e.g. John Smith").setRequired(true).setMaxLength(100)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("confirmation").setLabel("Type I AGREE to sign").setStyle(TextInputStyle.Short).setPlaceholder("I AGREE").setRequired(true).setMaxLength(10)),
  );
  await interaction.showModal(modal);
}

async function handleModal(interaction) {
  if (!interaction.customId.startsWith("modal_sign_")) return;
  const paymentId = interaction.customId.slice(11);
  const payment = getPayment(paymentId);
  if (!payment) return interaction.reply({ content: "❌ Invoice not found.", ephemeral: true });
  if (payment.signedAt) return interaction.reply({ content: "✅ This agreement has already been signed.", ephemeral: true });
  if (interaction.user.id !== payment.targetUserId) return interaction.reply({ content: "❌ Only the invoiced customer can sign this agreement.", ephemeral: true });
  const legalName = interaction.fields.getTextInputValue("legal_name").trim();
  const confirmationRaw = interaction.fields.getTextInputValue("confirmation").trim();
  if (confirmationRaw.toUpperCase() !== "I AGREE") return interaction.reply({ content: "❌ You must type **I AGREE** exactly.", ephemeral: true });
  const signedAt = new Date().toISOString();
  const updated = updatePayment(paymentId, { status: "signed", signedName: legalName, signedAt });
  const embed = new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  AGREEMENT SIGNED`).setDescription(`The customer has formally acknowledged the purchase agreement.`).addFields(
    { name: "Invoice", value: `\`${updated.invoiceNumber}\``, inline: true },
    { name: "Signed By", value: `${legalName} (${interaction.user.tag})`, inline: true },
    { name: "Amount", value: `£${updated.amount.toFixed(2)}`, inline: true },
    { name: "Delivery", value: "The purchased item/service will be delivered as soon as the payment is successfully confirmed, subject to the merchant's stated fulfilment terms.", inline: false },
  ).setFooter({ text: "Please complete payment via Stripe Checkout." }).setTimestamp(new Date(signedAt));
  await interaction.reply({ embeds: [embed], ephemeral: true });
  try {
    const creator = await client.users.fetch(payment.createdBy);
    await creator.send({ embeds: [embed] });
  } catch {}
}

function buildAgreementText(p) {
  const type = p.type === "subscription" ? "SUBSCRIPTION AGREEMENT" : p.type === "paylater" ? "PAY NOW / PAY LATER AGREEMENT" : p.type === "debt" ? "DEBT ACKNOWLEDGEMENT" : "PAYMENT AGREEMENT";
  return `${type}\n\nI acknowledge the purchase for "${p.product}" through Stripe Checkout.\n\nI understand and agree that:\n• The purchased item/service will be delivered as soon as the payment is successfully confirmed, subject to the merchant's stated fulfilment terms.\n• I have been given the merchant's Terms of Service and agree to them at checkout.\n• The final amount and billing terms shown on Stripe Checkout are the terms of this transaction.\n${p.type === "subscription" ? `• This subscription recurs ${p.interval?.toLowerCase()} until cancelled according to the subscription terms.\n` : ""}${p.type === "paylater" ? `• The remaining balance of £${p.remaining.toFixed(2)} is due by ${p.dueDate}.\n` : ""}\nThis agreement records my acknowledgement of the purchase terms.`;
}

async function createStripeCheckout(payment) {
  if (!stripe) throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY in Railway.");
  const invoiceId = payment.id;
  const subtotal = payment.totalBeforeDiscount ?? payment.amount;
  const discountPercent = Number(payment.discountPercent ?? 0);
  const lineItems = payment.type === "subscription"
    ? [{
        quantity: 1,
        price_data: {
          currency: "gbp",
          unit_amount: Math.round(Number(payment.amount) * 100),
          product_data: { name: String(payment.product).slice(0, 250), description: String(payment.description ?? "").slice(0, 500) || undefined },
          recurring: { interval: intervalToStripe(payment.interval) },
        },
      }]
    : payment.type === "paylater"
      ? [{ quantity: 1, price_data: { currency: "gbp", unit_amount: Math.round(Number(payment.deposit) * 100), product_data: { name: String(payment.product).slice(0, 250) } } }]
      : (payment.items ?? [{ name: payment.product, amount: payment.amount, quantity: 1 }]).map((item) => ({
          quantity: item.quantity ?? 1,
          price_data: {
            currency: "gbp",
            unit_amount: Math.round(Number(item.amount) * 100),
            product_data: { name: String(item.name).slice(0, 250) },
          },
        }));

  const sessionConfig = {
    mode: payment.type === "subscription" ? "subscription" : "payment",
    line_items: lineItems,
    ...(payment.email ? { customer_email: payment.email } : {}),
    ...(payment.type === "subscription" ? { submit_type: "subscribe" } : {}),
    success_url: `${STRIPE_SUCCESS_URL}?invoice_id=${encodeURIComponent(invoiceId)}&status=success`,
    cancel_url: `${STRIPE_CANCEL_URL}?invoice_id=${encodeURIComponent(invoiceId)}&status=cancelled`,
    client_reference_id: invoiceId,
    metadata: {
      invoice_id: invoiceId,
      invoice_number: payment.invoiceNumber,
      invoice_type: payment.type,
      target_user_id: payment.targetUserId,
      product: payment.product,
    },
    billing_address_collection: "required",
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      submit: {
        message: "By completing this purchase, you acknowledge that the purchased item/service will be delivered as soon as your payment is successfully confirmed, subject to the merchant's stated fulfilment terms.",
      },
    },
    automatic_tax: { enabled: true },
    payment_method_options: {
      card: { request_three_d_secure: "any" },
    },
    ...(payment.type === "subscription" ? { subscription_data: { metadata: { invoice_id: invoiceId, invoice_number: payment.invoiceNumber } } } : {
      payment_intent_data: { metadata: { invoice_id: invoiceId, invoice_number: payment.invoiceNumber } },
    }),
  };

  if (discountPercent > 0) {
    const coupon = await stripe.coupons.create({
      percent_off: discountPercent,
      duration: "once",
      name: `Invoice ${payment.invoiceNumber} • ${discountPercent}% discount`,
    });
    sessionConfig.discounts = [{ coupon: coupon.id }];
  }

  // Tax is intentionally handled entirely by Stripe Tax; the bot never invents a tax rate.
  return stripe.checkout.sessions.create(sessionConfig);
}

function intervalToStripe(interval) {
  const normalized = String(interval ?? "Monthly").toLowerCase();
  if (normalized === "weekly") return "week";
  if (normalized === "yearly") return "year";
  return "month";
}

async function refreshDiscordPaymentMessage(payment, mode = null) {
  if (!payment?.discordChannelId || !payment.discordMessageId) return;
  const channel = await client.channels.fetch(payment.discordChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const message = await channel.messages.fetch(payment.discordMessageId).catch(() => null);
  if (!message) return;
  const updated = buildPaymentEmbed(payment, mode ?? payment.status);
  const components = payment.status === "paid" || payment.status === "refunded" || payment.status === "voided" || payment.status === "disputed"
    ? []
    : [buildPayButton(payment.id, payment.stripeUrl), buildAgreementButton(payment.id)];
  await message.edit({ embeds: [updated], components }).catch(() => null);
}

function startStripeWebhookServer() {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.warn("Stripe webhook server not started: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing.");
    return;
  }
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/stripe/webhook") {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Not found" }));
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const rawBody = Buffer.concat(chunks);
        const signature = req.headers["stripe-signature"];
        const event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
        await handleStripeEvent(event);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        console.error("Stripe webhook error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid webhook" }));
      }
    });
  });
  server.listen(STRIPE_PORT, "0.0.0.0", () => console.log(`Stripe webhook listening on 0.0.0.0:${STRIPE_PORT}`));
}

async function handleStripeEvent(event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutCompleted(event.data.object, event.type);
    case "charge.dispute.created":
      return handleDisputeCreated(event.data.object);
    case "charge.dispute.updated":
      return handleDisputeUpdated(event.data.object);
    case "charge.dispute.closed":
      return handleDisputeClosed(event.data.object);
    case "charge.refunded":
      return handleChargeRefunded(event.data.object);
    case "payment_intent.payment_failed":
      return handlePaymentIntentFailed(event.data.object);
    case "invoice.paid":
      return handleSubscriptionInvoicePaid(event.data.object);
    case "invoice.payment_failed":
      return handleSubscriptionInvoiceFailed(event.data.object);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event.data.object);
    case "checkout.session.expired":
      return handleCheckoutExpired(event.data.object);
    default:
      return;
  }
}

async function handleCheckoutCompleted(session, eventType) {
  const invoiceId = session.client_reference_id || session.metadata?.invoice_id;
  if (!invoiceId) return;
  const payment = getPayment(invoiceId);
  if (!payment) return;
  const paid = eventType === "checkout.session.async_payment_succeeded" || session.payment_status === "paid" || payment.type === "subscription";
  if (!paid) return;
  if (payment.status === "paid") return;
  const updated = updatePayment(invoiceId, {
    status: "paid",
    paidAt: new Date().toISOString(),
    stripePaymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null,
    stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id ?? null,
    stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null,
  });
  await refreshDiscordPaymentMessage(updated, "paid");
  await sendPaymentLog(updated.guildId, buildPaymentEmbed(updated, "paid"));
  try {
    const creator = await client.users.fetch(updated.createdBy);
    await creator.send({ embeds: [buildPaymentEmbed(updated, "paid")] });
  } catch {}
  if (updated.sendDm) {
    try {
      const target = await client.users.fetch(updated.targetUserId);
      await target.send({ embeds: [buildPaymentEmbed(updated, "paid")] });
    } catch {}
  }
}

async function handleDisputeCreated(dispute) {
  const paymentIntentId = dispute.payment_intent ?? null;
  let payment = paymentIntentId ? findPaymentByStripePaymentIntent(paymentIntentId) : null;
  if (!payment && dispute.charge && stripe) {
    const charge = await stripe.charges.retrieve(dispute.charge).catch(() => null);
    const pi = typeof charge?.payment_intent === "string" ? charge.payment_intent : charge?.payment_intent?.id;
    if (pi) payment = findPaymentByStripePaymentIntent(pi);
  }
  if (!payment) return;
  const updated = updatePayment(payment.id, { status: "disputed", disputeStatus: "needs_response", disputeReason: dispute.reason ?? null, disputeId: dispute.id, disputeCreatedAt: new Date().toISOString() });
  await refreshDiscordPaymentMessage(updated, "dispute");
  await sendPaymentLog(updated.guildId, new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  ⚠️ PAYMENT DISPUTE`).setDescription(`**${updated.product}**\nA Stripe dispute has been opened.`).addFields(
    { name: "Customer", value: `<@${updated.targetUserId}>`, inline: true },
    { name: "Invoice", value: `\`${updated.invoiceNumber}\``, inline: true },
    { name: "Reason", value: dispute.reason ?? "Not supplied", inline: true },
    { name: "Dispute ID", value: `\`${dispute.id}\``, inline: false },
    { name: "Action", value: "Review the dispute in Stripe and submit evidence before the deadline.", inline: false },
  ).setFooter({ text: BRAND }).setTimestamp());
}

async function handleDisputeUpdated(dispute) {
  const payment = findPaymentByStripePaymentIntent(dispute.payment_intent ?? "");
  if (!payment) return;
  const updated = updatePayment(payment.id, { disputeStatus: dispute.status ?? "updated", disputeReason: dispute.reason ?? payment.disputeReason, disputeUpdatedAt: new Date().toISOString() });
  await refreshDiscordPaymentMessage(updated, "dispute");
}

async function handleDisputeClosed(dispute) {
  const payment = findPaymentByStripePaymentIntent(dispute.payment_intent ?? "");
  if (!payment) return;
  const result = dispute.status === "won" ? "won" : dispute.status === "lost" ? "lost" : "closed";
  const updated = updatePayment(payment.id, { status: result === "lost" ? "disputed" : "paid", disputeStatus: result, disputeClosedAt: new Date().toISOString() });
  await refreshDiscordPaymentMessage(updated, "dispute");
  await sendPaymentLog(updated.guildId, new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  DISPUTE ${result.toUpperCase()}`).setDescription(`**${updated.product}**`).addFields(
    { name: "Invoice", value: `\`${updated.invoiceNumber}\``, inline: true },
    { name: "Outcome", value: result.toUpperCase(), inline: true },
  ).setFooter({ text: BRAND }).setTimestamp());
}

async function handlePaymentIntentFailed(paymentIntent) {
  const invoiceId = paymentIntent.metadata?.invoice_id;
  const payment = invoiceId ? getPayment(invoiceId) : findPaymentByStripePaymentIntent(paymentIntent.id);
  if (!payment) return;
  const updated = updatePayment(payment.id, { status: "pending", paymentFailureCode: paymentIntent.last_payment_error?.code ?? null, paymentFailureMessage: paymentIntent.last_payment_error?.message ?? null, paymentFailedAt: new Date().toISOString() });
  await refreshDiscordPaymentMessage(updated, "failed");
  await sendPaymentLog(updated.guildId, new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  PAYMENT FAILED`).setDescription(`**${updated.product}**`).addFields(
    { name: "Invoice", value: `\`${updated.invoiceNumber}\``, inline: true },
    { name: "Customer", value: `<@${updated.targetUserId}>`, inline: true },
    { name: "Reason", value: paymentIntent.last_payment_error?.message ?? "Stripe reported a payment failure.", inline: false },
  ).setFooter({ text: BRAND }).setTimestamp());
}

async function handleSubscriptionInvoicePaid(invoice) {
  const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
  if (!subscriptionId) return;
  const payment = findPaymentByStripeSubscription(subscriptionId);
  if (!payment) return;
  const firstPayment = !payment.paidAt;
  const updated = updatePayment(payment.id, { status: "paid", paidAt: new Date().toISOString(), lastRecurringPaymentAt: new Date().toISOString(), lastInvoiceId: invoice.id, ...(firstPayment ? {} : {}) });
  await refreshDiscordPaymentMessage(updated, "paid");
  await sendPaymentLog(updated.guildId, new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  SUBSCRIPTION PAYMENT`).setDescription(`✅ Recurring payment received for **${updated.product}**.`).addFields(
    { name: "Invoice", value: `\`${updated.invoiceNumber}\``, inline: true },
    { name: "Amount", value: `£${((invoice.amount_paid ?? 0) / 100).toFixed(2)}`, inline: true },
    { name: "Stripe Invoice", value: `\`${invoice.id}\``, inline: false },
  ).setFooter({ text: BRAND }).setTimestamp());
}

async function handleSubscriptionInvoiceFailed(invoice) {
  const subscriptionId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id;
  if (!subscriptionId) return;
  const payment = findPaymentByStripeSubscription(subscriptionId);
  if (!payment) return;
  const updated = updatePayment(payment.id, { subscriptionStatus: "past_due", paymentFailureAt: new Date().toISOString() });
  await sendPaymentLog(updated.guildId, new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  SUBSCRIPTION PAYMENT FAILED`).setDescription(`⚠️ A recurring payment failed for **${updated.product}**.`).addFields(
    { name: "Invoice", value: `\`${updated.invoiceNumber}\``, inline: true },
    { name: "Stripe Invoice", value: `\`${invoice.id}\``, inline: true },
  ).setFooter({ text: BRAND }).setTimestamp());
  try {
    const creator = await client.users.fetch(updated.createdBy);
    await creator.send({ embeds: [new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  SUBSCRIPTION PAYMENT FAILED`).setDescription(`The recurring payment for **${updated.product}** failed in Stripe.`).addFields({ name: "Invoice", value: `\`${updated.invoiceNumber}\`` }, { name: "Stripe Invoice", value: `\`${invoice.id}\`` }).setTimestamp()] });
  } catch {}
}

async function handleSubscriptionDeleted(subscription) {
  const payment = findPaymentByStripeSubscription(subscription.id);
  if (!payment) return;
  const updated = updatePayment(payment.id, { subscriptionStatus: "canceled", subscriptionCancelledAt: new Date().toISOString() });
  await sendPaymentLog(updated.guildId, new EmbedBuilder().setColor(BLACK).setTitle(`${BRAND}  •  SUBSCRIPTION CANCELLED`).setDescription(`The subscription for **${updated.product}** is now cancelled.`).addFields({ name: "Invoice", value: `\`${updated.invoiceNumber}\``, inline: true }).setFooter({ text: BRAND }).setTimestamp());
}

async function handleCheckoutExpired(session) {
  const invoiceId = session.client_reference_id || session.metadata?.invoice_id;
  if (!invoiceId) return;
  const payment = getPayment(invoiceId);
  if (!payment || ["paid", "refunded", "voided"].includes(payment.status)) return;
  const updated = updatePayment(payment.id, { checkoutExpiredAt: new Date().toISOString() });
  await refreshDiscordPaymentMessage(updated, "expired");
}

async function handleChargeRefunded(charge) {
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!pi) return;
  const payment = findPaymentByStripePaymentIntent(pi);
  if (!payment) return;
  if (payment.status === "refunded") return;
  const updated = updatePayment(payment.id, { status: "refunded", refundedAt: new Date().toISOString(), refundedAmount: (charge.amount_refunded ?? 0) / 100 });
  await refreshDiscordPaymentMessage(updated, "refunded");
}

client.on(Events.Error, (err) => console.error("[Discord Error]", err));
process.on("unhandledRejection", (err) => console.error("[Unhandled Rejection]", err));
process.on("uncaughtException", (err) => console.error("[Uncaught Exception]", err));

client.login(token);
