import type { SerpAmazonProductResponse } from './providers/serpapi/serpapi.types';

/**
 * A real `amazon_product` answer (amazon.in, ASIN B0H82V826Z, probed 2026-09-21),
 * trimmed to the fields the mapper reads. Recorded rather than written from the
 * documentation: every SerpApi shape coded from the docs so far was wrong.
 */
export const AMAZON_PRODUCT_FIXTURE: SerpAmazonProductResponse = {
  product_results: {
    title: 'Samsung Galaxy Watch9 (44mm Bluetooth, Graphite)',
    brand: 'Visit the Samsung Store',
    price: '₹40,800',
    extracted_price: 40800,
    extracted_old_price: 41999,
    thumbnail: 'https://m.media-amazon.com/images/I/31MWWTOBwAL._SY300_SX300_QL70_FMwebp_.jpg',
    thumbnails: [
      'https://m.media-amazon.com/images/I/71QFwGKxHbL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71Q0tyLYXyL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71ezCEoXwBL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71C6Irdt3gL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71SAsRwjikL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71slAQ+SI3L._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71qwCYODxwL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71lkcNx3qKL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/81eyP-v5SML._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71QeK+1FViL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/712HNPF1HmL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/81sjz8FWtNL._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/71v2BpyVc2L._SL1500_.jpg',
    ],
    rating: 5,
    reviews: 8,
    stock: 'In stock',
  },
  about_item: [
    '[DESIGN] Galaxy Watch9 comes with an ergonomic, versatile and ultra-sleek (8.6mm slim-fit) design thats built to last with Sapphire glass and Armor Aluminum. The Super AMOLED display with up to 3000 nits brightness is easy to read even is bright light.',
    '[NEW PLATFORM] Galaxy Watch9 is 1st Smartwatch with Snapdragon Wear Elite which has a 3nm Processor that supercharges your daily routine & optimizes battery life. The enhanced BioActive Sensor provides more precise and comprehensive health and fitness monitoring and Dual GPS for improved and consistent location tracking.',
    '[HEALTH ASSIST] Galaxy AI Powered Health and Fitness monitoring: Vitals, Heart Health Score, Fitness Index and Personalized HR and FTP help elevate users max capability based on daily condition.',
    '[On-WRIST Intelligence] Fastest way to GEMINI, Without ever having to take out your phone, users can simply raise their wrist and speak to check messages, manage schedules, and control music completely hands-free, keeping you focused on your activities.',
    'Daily Wellness, Health Monitoring, Personalised AI Health',
  ],
  item_specifications: {
    operating_system: 'Wear OS 7.0',
    memory_storage_capacity: '32 GB',
    special_feature:
      'Heart Health Score, Lightweight, Iconic Design, Raise to Talk, Snapdragon Wear Elite, Vitals',
    battery_capacity: '445 Milliamp Hours',
    connectivity_technology: 'Bluetooth',
  },
  product_details: {
    operating_system: 'Wear OS 7.0',
    water_resistance_level: 'Water Resistant',
    colour: 'Graphite',
    battery_capacity: '445 Milliamp Hours',
    brand_name: 'Samsung',
    model_name: 'Samsung Galaxy Watch9',
  },
};
