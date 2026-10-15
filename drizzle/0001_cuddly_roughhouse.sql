CREATE TABLE `business_invites` (
	`id` varchar(36) NOT NULL,
	`businessId` varchar(36) NOT NULL,
	`codeHash` varchar(64) NOT NULL,
	`role` enum('manager','cashier','kitchen') NOT NULL,
	`createdByOpenId` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`usedAt` timestamp,
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `business_invites_id` PRIMARY KEY(`id`),
	CONSTRAINT `business_invites_codeHash_unique` UNIQUE(`codeHash`)
);
--> statement-breakpoint
CREATE TABLE `business_members` (
	`id` varchar(36) NOT NULL,
	`businessId` varchar(36) NOT NULL,
	`openId` varchar(64) NOT NULL,
	`displayName` varchar(160),
	`email` varchar(320),
	`role` enum('manager','cashier','kitchen') NOT NULL DEFAULT 'cashier',
	`status` enum('active','suspended') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `business_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `business_members_business_openid_uq` UNIQUE(`businessId`,`openId`)
);
--> statement-breakpoint
CREATE TABLE `business_records` (
	`id` varchar(36) NOT NULL,
	`businessId` varchar(36) NOT NULL,
	`recordKind` varchar(48) NOT NULL,
	`recordId` varchar(80) NOT NULL,
	`payload` json NOT NULL,
	`createdByOpenId` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `business_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `business_records_scope_key_uq` UNIQUE(`businessId`,`recordKind`,`recordId`)
);
--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` varchar(36) NOT NULL,
	`name` varchar(120) NOT NULL,
	`createdByOpenId` varchar(64) NOT NULL,
	`currency` enum('IDR','USD') NOT NULL DEFAULT 'IDR',
	`taxRateBasisPoints` int NOT NULL DEFAULT 0,
	`timezone` varchar(64) NOT NULL DEFAULT 'Asia/Jakarta',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `businesses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `business_invites_business_idx` ON `business_invites` (`businessId`);--> statement-breakpoint
CREATE INDEX `business_members_openid_idx` ON `business_members` (`openId`);--> statement-breakpoint
CREATE INDEX `business_records_kind_idx` ON `business_records` (`businessId`,`recordKind`,`createdAt`);