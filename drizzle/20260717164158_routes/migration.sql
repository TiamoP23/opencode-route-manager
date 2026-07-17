CREATE TABLE `routes` (
	`slug` text PRIMARY KEY,
	`port` integer NOT NULL,
	`description` text,
	`status` text NOT NULL,
	`cloudflare_record_id` text,
	`last_error_code` text,
	`last_error_message` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "routes_status_check" CHECK("status" in ('creating', 'active', 'deleting')),
	CONSTRAINT "routes_port_check" CHECK("port" between 1 and 65535)
);
