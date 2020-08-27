/*jslint node: true */
'use strict';
const constants = require('ocore/constants.js');
const conf = require('ocore/conf');
const db = require('ocore/db');
const eventBus = require('ocore/event_bus');
const validationUtils = require('ocore/validation_utils');
const headlessWallet = require('headless-obyte');

var sessionData = {};
var smartContracts = {};
var stakeAmounts = {};

/**
 * headless wallet is ready
 */
eventBus.once('headless_wallet_ready', () => {
	headlessWallet.setupChatEventHandlers();
	
	/**
	 * user pairs his device with the bot
	 */
	eventBus.on('paired', (from_address, pairing_secret) => {
		// send a geeting message
		const device = require('ocore/device.js');
		device.sendMessageToDevice(from_address, 'text', "Welcome to my new shiny bot!");
	});

	/**
	 * user sends message to the bot
	 */
	eventBus.on('text', (from_address, text) => {
		// analyze the text and respond https://regex101.com/
		text = text.trim();
		let arrSignedMessageMatches = text.match(/\(signed-message:(.+?)\)/);
		let newAmountMatches = text.match(/^\d+$/);
		
		const device = require('ocore/device.js');
		if (arrSignedMessageMatches){
			//console.error(arrSignedMessageMatches);
			let signedMessageBase64 = arrSignedMessageMatches[1];
			let validation = require('ocore/validation.js');
			let signedMessageJson = Buffer.from(signedMessageBase64, 'base64').toString('utf8');
			try{
				var objSignedMessage = JSON.parse(signedMessageJson);
			}
			catch(e){
				return null;
			}
			validation.validateSignedMessage(objSignedMessage, err => {
				if (err)
					return device.sendMessageToDevice(from_address, 'text', err);
				sessionData[from_address] = objSignedMessage.authors[0].address;
				stakeAmounts[from_address] = 0;
			});
		}
		if (newAmountMatches) {
			//console.error(newAmountMatches);
			stakeAmounts[from_address] = parseInt(newAmountMatches[0]);
		}
		
		if (!sessionData[from_address]) {
			device.sendMessageToDevice(from_address, 'text', "[any text](sign-message-request:I agree to share my address)");
		}
		else if (!stakeAmounts[from_address] || stakeAmounts[from_address] < 50000) {
			device.sendMessageToDevice(from_address, 'text', "Staked amount should be [50 000](suggest-command:50000) bytes or higher.\nPlease enter new amount in bytes.");
		}
		else if (stakeAmounts[from_address] && stakeAmounts[from_address] >= 50000) {
			headlessWallet.readFirstAddress(function(bot_address){
				let current_time = Math.round(Date.now()/1000);
				let vesting_ts = current_time + Math.round(conf.timeoutHours * 3600);
				let claim_back_ts = current_time + Math.round(conf.timeoutHours * 2 * 3600);
				let arrDefinition = ['or', [
					['and', [
						['address', sessionData[from_address]],
						['timestamp', ['>', vesting_ts]]
					]],
					['and', [
						['address', bot_address],
						['timestamp', ['>', claim_back_ts]]
					]]
				]];
				let assocSignersByPath = {
					'r.0.0': {
						address: sessionData[from_address],
						member_signing_path: 'r',
						device_address: from_address
					},
					'r.1.0': {
						address: bot_address,
						member_signing_path: 'r',
						device_address: device.getMyDeviceAddress()
					}
				};
				var walletDefinedByAddresses = require('ocore/wallet_defined_by_addresses.js');
				walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
					ifError: function(err){
						return device.sendMessageToDevice(from_address, 'text', err);
					},
					ifOk: function(shared_address){
						smartContracts[shared_address] = from_address;
						var arrPayments = [{address: shared_address, amount: stakeAmounts[from_address], asset: 'base'}];
						var assocDefinitions = {};
						assocDefinitions[shared_address] = {
							definition: arrDefinition,
							signers: assocSignersByPath
						};
						var objPaymentRequest = {payments: arrPayments, definitions: assocDefinitions};
						var paymentJson = JSON.stringify(objPaymentRequest);
						var paymentJsonBase64 = Buffer.from(paymentJson).toString('base64');
						var paymentRequestCode = 'payment:'+paymentJsonBase64;
						var paymentRequestText = '[your share of payment to the contract]('+paymentRequestCode+')';
						device.sendMessageToDevice(from_address, 'text', paymentRequestText);
						stakeAmounts[from_address] = 0;
					}
				});
			});
		}
		else if (!text.match(/^You said/))
			device.sendMessageToDevice(from_address, 'text', "You said: " + text);
	});

});


/**
 * user pays to the bot
 */
eventBus.on('new_my_transactions', (arrUnits) => {
	// handle new unconfirmed payments
	// and notify user
	const device = require('ocore/device.js');
	db.query("SELECT address, amount FROM outputs WHERE unit IN("+arrUnits.map(db.escape).join(',')+") AND asset IS NULL;", function(rows){
		if (rows.length === 0)
			return;
		rows.forEach(function(row){
			if (smartContracts[row.address]) {
				device.sendMessageToDevice(smartContracts[row.address], 'text', "Received you payment amount " + row.amount + " bytes.\nWaiting for the transaction to confirm.");
			}
		});
	});
});

/**
 * payment is confirmed
 */
eventBus.on('my_transactions_became_stable', (arrUnits) => {
	// handle payments becoming confirmed
	// and notify user
	const device = require('ocore/device.js');
	db.query("SELECT address, amount FROM outputs WHERE unit IN("+arrUnits.map(db.escape).join(',')+") AND asset IS NULL;", function(rows){
		if (rows.length === 0) {
			console.error('No outputs.', arrUnits);
			return;
		}
		headlessWallet.readFirstAddress(function(bot_address){
			rows.forEach(function(row){
				if (!(smartContracts[row.address] && sessionData[smartContracts[row.address]])) {
					return;
				}
				let device_address = smartContracts[row.address];
				let user_address = sessionData[smartContracts[row.address]];
				let reward = Math.ceil(row.amount*0.02); // 2%
				headlessWallet.sendAssetFromAddress(
					null,
					reward,
					bot_address,
					user_address,
					device_address,
				function(err, unit) {
					if (err) {
						device.sendMessageToDevice(device_address, 'text', "Sorry. It failed.");
						console.error("failed to send reward: ", err);
					}
					else {
						console.error("sent reward, unit " + unit);
					}
				});
			});
		});
	});
});



process.on('unhandledRejection', up => { throw up; });
