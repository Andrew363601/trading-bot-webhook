/**
 * Stripe Setup Script
 * This script creates the necessary Products, Prices, and Billing Meters 
 * in your Stripe account for the Nexus platform.
 * 
 * Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js
 */

import Stripe from 'stripe';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  console.error('Error: STRIPE_SECRET_KEY environment variable is required.');
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey);

async function setupStripe() {
  console.log('🚀 Starting Stripe Setup...');

  try {
    // 1. Create Usage Meters
    console.log('Creating Billing Meters...');
    
    const apiMeter = await stripe.billing.meters.create({
      display_name: 'Hermes API Calls',
      event_name: 'hermes_api_call',
      default_aggregation: { formula: 'count' },
    });
    console.log(`✅ Created Meter: ${apiMeter.display_name} (${apiMeter.id})`);

    const chatMeter = await stripe.billing.meters.create({
      display_name: 'Chat Messages',
      event_name: 'chat_message',
      default_aggregation: { formula: 'count' },
    });
    console.log(`✅ Created Meter: ${chatMeter.display_name} (${chatMeter.id})`);

    // 2. Create Products
    console.log('\nCreating Products...');

    const products = [
      {
        name: 'Nexus Retail',
        description: '1 Active Asset, Standard Routing, Discord Alerts',
        metadata: { tier: 'RETAIL' }
      },
      {
        name: 'Nexus Pro',
        description: '5 Active Assets, High-Priority, Agentic Reflection, Multi-TF X-Ray',
        metadata: { tier: 'PRO' }
      },
      {
        name: 'Nexus Institutional',
        description: 'Unlimited Assets, Colocated HFT Speeds, Full Order Book Depth',
        metadata: { tier: 'INSTITUTIONAL' }
      }
    ];

    const createdProducts = [];
    for (const p of products) {
      const product = await stripe.products.create(p);
      createdProducts.push(product);
      console.log(`✅ Created Product: ${product.name} (${product.id})`);
    }

    // 3. Create Prices (Flat Fee + Usage)
    console.log('\nCreating Prices...');

    const priceConfigs = [
      {
        product: createdProducts[0].id, // Retail
        unit_amount: 4900, // $49.00
        tier: 'RETAIL'
      },
      {
        product: createdProducts[1].id, // Pro
        unit_amount: 14900, // $149.00
        tier: 'PRO'
      },
      {
        product: createdProducts[2].id, // Institutional
        unit_amount: 49900, // $499.00
        tier: 'INSTITUTIONAL'
      }
    ];

    const envVars = [];

    for (const config of priceConfigs) {
      // Create the recurring price
      const price = await stripe.prices.create({
        product: config.product,
        unit_amount: config.unit_amount,
        currency: 'usd',
        recurring: { interval: 'month' },
        metadata: { tier: config.tier }
      });
      
      console.log(`✅ Created Price for ${config.tier}: ${price.id}`);
      envVars.push(`STRIPE_PRICE_${config.tier}=${price.id}`);

      // Optional: Add usage-based price components here if you want tiered pricing for API calls
      // For now, we will track usage in the meter and you can link them in the Stripe Dashboard
      // to keep this script simple and robust.
    }

    console.log('\n--- SETUP COMPLETE ---');
    console.log('Add these to your Vercel Environment Variables:');
    envVars.forEach(v => console.log(v));
    console.log(`STRIPE_METER_API=${apiMeter.id}`);
    console.log(`STRIPE_METER_CHAT=${chatMeter.id}`);
    console.log('\nNext Step: Go to your Stripe Dashboard, click on each Price, and add the "Usage-based" component linked to the Meters created above.');

  } catch (error) {
    console.error('❌ Setup Failed:', error.message);
  }
}

setupStripe();
