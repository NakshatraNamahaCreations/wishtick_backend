Wishtick MVP Scope
1. Onboarding & User Profiles
User Authentication & Onboarding
Users can create an account and log in through a simple onboarding flow.
Supported actions:s
•	Signup and login
•	Email or mobile-based authentication
•	Password reset and account recovery
•	Basic session handling
•	Account verification where required
Onboarding Data Capture
During onboarding, users provide information that helps personalize the platform:
•	Interests and hobbies
•	Favorite colors
•	Usual clothing size / fit preferences
•	Optional shoe size
•	Preferred gifting categories
•	General lifestyle preferences
•	Optional occasion preferences
This data helps in:
•	Better wishlist suggestions
•	More relevant gifting experiences
•	Better personalization of event and reel features
________________________________________
User Profile Dashboard
Each user gets a structured dashboard with clear sections for their activities and gifting history.
Dashboard Sections
•	My Events
•	Create Event
•	Invited Events
•	Gifts Given
•	Gifts Received
•	Gifts on Hold by Me
•	My Wishlist
•	Events & Invites
•	Wishlist Chats
•	Group Gift Chats
•	Notifications
•	Profile Settings
Profile Data
The profile should store:
•	Name
•	Profile photo
•	Contact info
•	Preferences
•	Event history
•	Wishlist history
•	Gifting history
•	Chat access tied to wishlist/event permissions
________________________________________
2. Event Creation & Invite System
Event Types
Users can create different kinds of occasions, including:
•	Birthday events
•	Anniversary events
•	Generic/custom events
•	Special celebration events
Event Setup Fields
Each event can include:
•	Event title
•	Event type
•	Event date and time
•	Event description
•	Cover image
•	Invite list
•	Visibility settings
•	Related wishlist link
•	Related reel collection link if applicable
________________________________________
Interactive Invite Templates
Users can design and share invitations using templates.
Template Support
•	3 core invite template designs
•	5–6 colour variations per template
•	Designs for birthdays
•	Designs for anniversaries
•	Designs for generic events
Invite Features
•	Editable preview before sharing
•	WhatsApp-shareable preview
•	Shareable link generation
•	Event branding and personalization
•	Optional RSVP response area
________________________________________
3. Wishlist Management
Wishlist Overview
Wishlists are one of the main parts of the product. Users can create and maintain one or more wishlists linked to their profile and events.
Wishlist Actions
Users can:
•	Create wishlist items
•	Edit wishlist items
•	Remove wishlist items
•	Prioritize items
•	Mark item importance
•	Group items by category
•	Add notes for each item
•	Attach images or product links
•	Set gift preferences
________________________________________
Wishlist Types
Public Wishlist
A public wishlist is visible to anyone who has access to the profile or shared link.
Used for:
•	Open birthday wishes
•	Public event gifting
•	Easy sharing with friends, family, or coworkers
Visibility:
•	Can be viewed by anyone with the link
•	Can allow discussions depending on permissions
•	Can be shared through WhatsApp or similar channels
Private Wishlist
A private wishlist is visible only to selected people.
Used for:
•	Personal or family events
•	Sensitive or surprise gifting
•	Controlled access gifting experiences
Visibility:
•	Only invited users can view it
•	Only approved participants can interact
•	Chat access is restricted to authorized users
Optional Privacy Controls
•	Public
•	Private
•	Event-only
•	Invite-only
________________________________________
Wishlist Sharing
Wishlists can be shared easily.
Supported sharing:
•	WhatsApp share preview
•	Shareable wishlist link
•	Event-based wishlist sharing
•	Group gifting share cards
________________________________________
4. Wishlist Chat & Collaboration
This is a key launch feature and should exist inside both personal wishlists and group gifting flows.
Personal Wishlist Chat
Every personal wishlist can include a dedicated chat area for discussion around wishlist items.
Purpose
This allows people to talk inside the app instead of moving the conversation elsewhere.
Personal Wishlist Chat Use Cases
•	Ask about item preferences
•	Discuss gift ideas
•	Clarify colours, sizes, or styles
•	Suggest alternate gifts
•	Coordinate surprise gifts
•	Prevent duplicate purchases
Features
•	Real-time messaging
•	Message history
•	Timestamps
•	Read indicators
•	Reply support
•	Basic emoji reactions
•	Attachment support later if needed
•	Chat notifications
Access Rules
•	Public wishlist chat: visible to users with access to the wishlist
•	Private wishlist chat: visible only to invited or approved users
•	Wishlist owner can control who can participate
________________________________________
Group Gift Chat
Each group gifting experience gets its own dedicated chat.
Purpose
This allows contributors to coordinate smoothly while fulfilling one gift together.
Group Gift Chat Use Cases
•	Discuss contribution amounts
•	Plan surprise gifting
•	Confirm who is contributing
•	Decide on product choice
•	Coordinate delivery timing
•	Share updates on purchase status
•	Resolve confusion before gifting
Features
•	Group-only chat
•	Real-time messaging
•	Contribution updates in chat
•	Automatic system messages
•	Seen/read status
•	Participant list
•	Chat history
•	Event-linked chat context
System Messages in Group Chat
The system can automatically post updates such as:
•	A user joined the gift group
•	Contribution received
•	Gift reserved
•	Contribution goal reached
•	Gift purchased
•	Gift marked offline
•	Shipment confirmed
•	Gift fulfilled
This keeps the group informed without manual updates.
________________________________________
5. Product Search, Affiliate Integration & Wishlist Import
Third-Party Affiliate Integration
The platform will integrate with a third-party affiliate product API or product discovery tool.
Product Search Features
Users can:
•	Search for products
•	Browse product categories
•	View product details
•	Check product price
•	View merchant/source data
•	Import selected products into wishlists
Imported Product Data
When a product is added to a wishlist, the system should store:
•	Product title
•	Product image
•	Product link
•	Price
•	Merchant/source
•	Product description
•	Category
•	Affiliate metadata if available
________________________________________
Wishlist Item Import Flow
Users can:
1.	Search for a product
2.	Open product details
3.	Add it to their wishlist
4.	Add notes and preferences
5.	Share the wishlist item with others
________________________________________
6. Gifting Flows
Single Gifting
A single user can fulfill a wishlist item for another person.
Single Gifting Features
•	Reserve an item
•	Purchase an item
•	Mark as purchased
•	Mark as fulfilled
•	Track gift status
•	Add delivery notes
•	Keep it private or visible depending on permissions
________________________________________
Group Gifting
Multiple users can contribute toward one gift.
Group Gifting Features
•	Create a group gift for one wishlist item
•	Invite contributors
•	Track participation
•	Show progress toward target amount
•	Support multiple contributions
•	Display group gift status
•	Allow chat around the gift
________________________________________
Offline Gift Option
Not every gift will be purchased through the API or affiliate flow, so the platform should support offline gifting.
Offline Gift Features
Users can:
•	Mark a wishlist item as gifted offline
•	Reserve an item manually
•	Confirm that the gift was bought elsewhere
•	Add optional delivery notes
•	Record gift completion without online order tracking
This ensures the platform can still track real-world gifting even when the gift was purchased outside the system.
________________________________________
Auto-Ticking / Auto-Fulfillment via API
If a gift is purchased through the integrated product or affiliate API, the system should automatically update the gift status.
Auto-Ticking Behavior
When API signals a successful order or fulfillment event:
•	The item is automatically marked as purchased
•	The item can be automatically marked as fulfilled when shipment or completion is confirmed
•	The user’s dashboard updates instantly
•	Duplicate gifting is reduced
•	Group gift progress updates automatically
Status Examples
•	Available
•	Reserved
•	Purchased
•	Fulfilled
•	Gifted Offline
•	Completed
________________________________________
Gifts on Hold by Me
This section tracks gifts the user has reserved or committed to.
It can include:
•	Reserved gifts
•	Purchased gifts
•	Pending gifts
•	Offline commitments
•	Group gift commitments
•	Delivery tracking where relevant
________________________________________
7. Notifications & Thank-You System
Notification Types
Notifications should be built for important user actions and platform updates.
Email Notifications
Used for:
•	Signup confirmation
•	Event invites
•	Wishlist updates
•	Gift reservations
•	Group gift updates
•	Gift fulfillment updates
•	Thank-you notes
•	Reel release notifications
SMS Notifications
Used for:
•	Time-sensitive event reminders
•	Important gift updates
•	Event date reminders
•	Critical account notifications
________________________________________
Automated Thank-You Notes
When a gift is received, the platform can automatically generate and send a thank-you message.
Thank-You Features
•	Triggered after gift receipt
•	Sent via email
•	Personalized with recipient name and event context
•	Can include gift details
•	Can be simple and elegant
________________________________________
8. The Reels Feature
Birthday Wishes Collection
Users can submit birthday wishes in multiple formats.
Supported formats:
•	Text
•	Audio
•	Video
Submission Timing
Users may submit wishes at any time before the birthday.
Time-Locked Release
All wishes remain locked until the recipient’s birthday.
Rules:
•	No early access
•	Release happens automatically on the birthday
•	Submission date does not matter
•	All content unlocks together
________________________________________

Auto-Compilation into Reel
When released, the system automatically compiles all wishes into a single reel.
Reel Content
•	Text wishes
•	Audio wishes
•	Video wishes
Reel Enhancements
•	Subtle background music
•	Intro animation
•	Outro animation
•	Wishtick watermark frame
•	Smooth content transitions
•	Branded presentation style
________________________________________
9. Admin Panel & Moderation
Admin Authentication
Admin access must be secured and restricted.
Features
•	Admin login
•	Role-based permissions
•	Secure access control
•	Session management
________________________________________
User Management
Admins should be able to:
•	View users
•	Search users
•	Review user profiles
•	Moderate suspicious users
•	Suspend accounts
•	Reactivate accounts
•	Monitor platform activity
________________________________________
Content Moderation
Moderation should focus on user-generated content.
Content Types
•	Text
•	Audio
•	Video
•	Reels
•	Chat content if flagged
Moderation Actions
•	Approve
•	Remove
•	Flag
•	Review reported content
•	Escalate abuse cases
________________________________________
10. Analytics Dashboard
Core User Metrics
Track the health of the platform through:
•	Total users
•	Daily Active Users (DAU)
•	Weekly Active Users (WAU)
•	Monthly Active Users (MAU)
________________________________________
Acquisition Tracking
Track how users join the platform through:
•	Invite-based acquisition
•	Organic acquisition
•	Group gifting referrals
•	Referral links
•	WhatsApp sharing
•	Other acquisition sources
________________________________________
Product Engagement Metrics
Track:
•	Invites created
•	Events created
•	Wishlists created
•	Wishlist items added
•	Wishlist items fulfilled
•	Public wishlist usage
•	Private wishlist usage
•	Chat activity in wishlists
•	Chat activity in group gifting
•	Gifts reserved
•	Gifts purchased
•	Gifts fulfilled
•	Offline gifts marked complete
•	Reels submitted
•	Reels generated
•	Reel shares
________________________________________
Launch Version Summary
The Wishtick MVP should launch with:
•	User signup, login, and onboarding
•	Profile dashboard
•	Event creation and invitation templates
•	Public and private wishlists
•	Wishlist product search and affiliate import
•	Personal wishlist chat
•	Group gift chat
•	Single gifting
•	Group gifting
•	Offline gifting support
•	Auto gift ticking through API fulfillment
•	Email and SMS notifications
•	Automated thank-you notes
•	Birthday wishes reel feature
•	Admin moderation panel
•	Analytics dashboard
•	WhatsApp sharing for invites, wishlists, and gift campaigns

