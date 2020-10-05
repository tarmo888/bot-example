/*jslint node: true */
'use strict';
const constants = require('ocore/constants.js');
const conf = require('ocore/conf');
const db = require('ocore/db');
const eventBus = require('ocore/event_bus');
const validationUtils = require('ocore/validation_utils');
const headlessWallet = require('headless-obyte');

Array.prototype.forEachAsync = async function(fn) {
	for (let t of this) { await fn(t) }
}

const pairingProtocol = process.env.testnet ? 'obyte-tn:' : 'obyte:';
const maxOutputs = constants.MAX_OUTPUTS_PER_PAYMENT_MESSAGE-1;

var botFirstAddress;
var assocDevice2Amount = {};
var assocDeposit2Device = {};
var assocDeposit2Address = {};

eventBus.once('headless_wallet_ready', () => {
	headlessWallet.setupChatEventHandlers();

	headlessWallet.readFirstAddress(address => {
		botFirstAddress = address;

		eventBus.on('paired', (from_address, pairing_secret) => {
			const device = require('ocore/device.js');
			device.sendMessageToDevice(from_address, 'text', "How much do you want to send in bytes?");
		});
	
		eventBus.on('text', (from_address, text) => {
			const device = require('ocore/device.js');
			text = text.trim();
			let newAmountMatches = text.match(/^\d+$/);
			
			if (newAmountMatches) {
				if (parseInt(newAmountMatches[0]) < 10000) {
					return device.sendMessageToDevice(from_address, 'text', "Too small. Enter 10000 or more.");
				}
				assocDevice2Amount[from_address] = parseInt(newAmountMatches[0]);
				device.sendMessageToDevice(from_address, 'text',
						"Amount changed to "+ assocDevice2Amount[from_address] + " bytes.");
			}
			if (validationUtils.isValidAddress(text)) {
				headlessWallet.issueNextMainAddress((address) => {
					assocDeposit2Device[address] = from_address;
					assocDeposit2Address[address] = text;
					let amount = assocDevice2Amount[from_address] ? assocDevice2Amount[from_address] : 10000;
					device.sendMessageToDevice(from_address, 'text',
							'[Send payment]('+ pairingProtocol + address + '?amount=' + amount + ')');
				});
			}
			else {
				device.sendMessageToDevice(from_address, 'text',
						"Please insert the address whom you want to send or the amount of bytes you want to send.");
			}
		});
	});
});

eventBus.on('new_my_transactions', (arrUnits) => {
	const device = require('ocore/device.js');
	db.query("SELECT address, amount FROM outputs \
			WHERE unit IN(?) AND asset IS NULL;", [arrUnits], (rows) => {
		if (rows.length === 0) return;
		rows.forEach((row) => {
			if (!assocDeposit2Device[row.address]) return;
			device.sendMessageToDevice(assocDeposit2Device[row.address], 'text',
					"Received your payment of " + row.amount + " bytes.\nWaiting for the transaction to confirm.");
		});
	});
});

eventBus.on('my_transactions_became_stable', (arrUnits) => {
	const device = require('ocore/device.js');
	db.query("SELECT address, SUM(amount) AS amount FROM outputs \
			WHERE unit IN(?) AND asset IS NULL GROUP BY address;", [arrUnits], async (rows)  => {
		if (rows.length === 0) return;
		var arrOutputs = [];
		await rows.forEachAsync((row) => {
			if (!assocDeposit2Device[row.address]) return;
			let from_address = assocDeposit2Device[row.address];
			if (!assocDeposit2Address[row.address]) {
				return device.sendMessageToDevice(from_address, 'text', "Sorry. Failed to find address.");
			}
			arrOutputs.push({amount: row.amount-1000, address: assocDeposit2Address[row.address]});
			device.sendMessageToDevice(from_address, 'text',
					row.amount-1000 + ' bytes sent to ' + assocDeposit2Address[row.address]);
		});
		if (!arrOutputs) return;
		var i,j;
		for (i=0,j=arrOutputs.length; i<j; i+=maxOutputs) {
			var base_outputs = arrOutputs.slice(i,i+maxOutputs);
			headlessWallet.sendMultiPayment({change_address: botFirstAddress, base_outputs}, (err, unit) => {
				if (err) console.error("failed to send payment: ", err);
				else console.error("unit " + unit);
			});
		}
	});
});


process.on('unhandledRejection', up => { throw up; });
