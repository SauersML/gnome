export type ChatMessage = {
	id: string;
	content: string;
	user: string;
	role: "user" | "assistant";
};

export type Page = {
	slug: string;
	title: string;
	abstract: string;
	body: string;
};

export type Message =
	| {
			type: "add";
			id: string;
			content: string;
			user: string;
			role: "user" | "assistant";
	  }
	| {
			type: "update";
			id: string;
			content: string;
			user: string;
			role: "user" | "assistant";
	  }
	| {
			type: "all";
			messages: ChatMessage[];
	  }
	| {
			type: "css";
			css: string;
	  }
	| {
			type: "pages";
			pages: Page[];
	  }
	| {
			type: "page-update";
			page: Page;
	  }
	| {
			type: "typing";
			user: string;
			isTyping: boolean;
	  }
	| {
			type: "presence";
			count: number;
	  }
	| {
			type: "stream";
			id: string;
			user: string;
			delta: string;
	  }
	| {
			type: "stream-end";
			id: string;
			user: string;
			content: string;
	  };