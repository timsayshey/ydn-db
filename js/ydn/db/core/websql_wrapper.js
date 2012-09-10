// Copyright 2012 YDN Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Wrapper for Web SQL storage.
 *
 * @see http://www.w3.org/TR/webdatabase/
 *
 * @author kyawtun@yathit.com (Kyaw Tun)
 */

goog.provide('ydn.db.WebSqlWrapper');
goog.require('goog.async.Deferred');
goog.require('goog.debug.Logger');
goog.require('goog.events');
goog.require('ydn.async');
goog.require('ydn.json');
goog.require('ydn.db');
goog.require('ydn.db.SqlTxMutex');


/**
 * Construct WebSql database.
 * Note: Version is ignored, since it does work well.
 * @param {string} dbname name of database.
 * @param {!ydn.db.DatabaseSchema} schema table schema contain table
 * name and keyPath.
 * @implements {ydn.db.CoreService}
 * @constructor
 */
ydn.db.WebSqlWrapper = function(dbname, schema) {
  var self = this;
  this.dbname = dbname;
  /**
   * @final
   * @protected
   * @type {!ydn.db.DatabaseSchema}
   */
  this.schema = schema; // we always use the last schema.

  var description = this.dbname;

  /**
   * Transaction queue
   * @type {!Array.<{fnc: Function, scopes: Array.<string>,
   * mode: ydn.db.TransactionMode}>}
   */
  this.sql_tx_queue = [];  

  /**
   * Must open the database with empty version, otherwise unrecoverable error
   * will occur in the first instance.
   */
  this.sql_db_ = goog.global.openDatabase(this.dbname, '', description,
    this.schema.size);

  if (this.sql_db_.version != this.schema.version) {
    this.migrate_();
  }

};


/**
 * @const
 * @type {string}
 */
ydn.db.WebSqlWrapper.TYPE = 'websql';

/**
 * @return {string}
 */
ydn.db.WebSqlWrapper.prototype.type = function() {
  return ydn.db.WebSqlWrapper.TYPE;
};

//
//ydn.db.WebSqlWrapper.prototype.getDb = function() {
//  return this.sql_db_;
//};


/**
 *
 * @type {Database}
 * @private
 */
ydn.db.WebSqlWrapper.prototype.sql_db_ = null;


/**
 *
 */
ydn.db.WebSqlWrapper.prototype.getDbInstance = function() {
  return this.sql_db_ || null;
};


/**
 *
 * @return {boolean} true if supported.
 */
ydn.db.WebSqlWrapper.isSupported = function() {
  return goog.isFunction(goog.global.openDatabase);
};


/**
 * @const
 * @type {boolean} debug flag.
 */
ydn.db.WebSqlWrapper.DEBUG = false;


/**
 * @protected
 * @type {goog.debug.Logger} logger.
 */
ydn.db.WebSqlWrapper.prototype.logger = goog.debug.Logger.getLogger('ydn.db.WebSqlWrapper');


/**
 * Run the first transaction task in the queue.
 * @private
 */
ydn.db.WebSqlWrapper.prototype.runTxQueue_ = function() {

  var task = this.sql_tx_queue.shift();
  if (task) {
  //  if (this.isOpenTransaction()) { //
      this.doSqlTransaction(task.fnc, task.scopes, task.mode);
//    } else {
//      // only open transaction can continue to use existing transaction.
//      goog.Timer.callOnce(function() {
//        this.doSqlTransaction(task.fnc, task.scopes, task.mode);
//      }, 100, this);
//    }
  }
};


/**
 * Abort the queuing tasks.
 * @private
 * @param e
 */
ydn.db.WebSqlWrapper.prototype.abortTxQueue_ = function(e) {
  if (this.sql_tx_queue) {
    var task = this.sql_tx_queue.shift();
    while (task) {
      task = this.sql_tx_queue.shift();
      task.fnc(null); // TODO: any better way ?
    }
  }
};


/**
 * Existence of transaction object indicate that this database is in
 * transaction. This must be set to null on finished.
 * @private
 * @final
 * @type {!ydn.db.SqlTxMutex}
 */
ydn.db.WebSqlWrapper.prototype.sql_mu_tx_ = new ydn.db.SqlTxMutex();


/**
 * @final
 * @protected
 * @return {ydn.db.SqlTxMutex} transaction object if in
 * transaction.
 */
ydn.db.WebSqlWrapper.prototype.getActiveSqlTx = function() {
  return this.sql_mu_tx_.isActiveAndAvailable() ? this.sql_mu_tx_ : null;
};


/**
 * Initialize variable to the schema and prepare SQL statement for creating
 * the table.
 * @private
 * @param {ydn.db.StoreSchema} schema name of table in the schema.
 * @return {string} SQL statement for creating the table.
 */
ydn.db.WebSqlWrapper.prototype.prepareCreateTable_ = function(schema) {

  var sql = 'CREATE TABLE IF NOT EXISTS ' + schema.getQuotedName() + ' (';

  var id_column_name = schema.getQuotedKeyPath() ||
      ydn.db.DEFAULT_KEY_COLUMN;

  if (goog.isDef(schema.keyPath)) {
      sql += schema.getQuotedKeyPath() + ' TEXT UNIQUE PRIMARY KEY';
  } else {
    // NOTE: we could have use AUTOINCREMENT here,
    // however put request require to return key. If we use AUTOINCREMENT, the key value
    // have to query again after INSERT since it does not return any result.
    // generating the by ourselves eliminate this.
    // for generating see ydn.db.StoreSchema.prototype.generateKey
    sql += ydn.db.DEFAULT_KEY_COLUMN + ' INTEGER PRIMARY KEY';
  }

  // every table must has a default field.
  if (!schema.hasIndex(ydn.db.DEFAULT_BLOB_COLUMN)) {
    schema.addIndex(ydn.db.DEFAULT_BLOB_COLUMN);
  }

  for (var i = 0; i < schema.indexes.length; i++) {
    /**
     * @type {ydn.db.IndexSchema}
     */
    var index = schema.indexes[i];
    if (index.name == schema.keyPath) {
      continue;
    }
    var primary = index.unique ? ' UNIQUE ' : ' ';
    sql += ', ' + index.name + ' ' + index.type + primary;
  }

  sql += ');';

  return sql;
};


/**
 * Migrate from current version to the last version.
 * @private
 */
ydn.db.WebSqlWrapper.prototype.migrate_ = function() {

  var me = this;


  /**
   * @param {SQLTransaction} transaction transaction.
   * @param {SQLResultSet} results results.
   */
  var success_callback = function(transaction, results) {
    if (ydn.db.WebSqlWrapper.DEBUG) {
      window.console.log(results);
    }
    me.logger.finest('Creating tables OK.');

  };

  /**
   * @param {SQLTransaction} tr transaction.
   * @param {SQLError} error error.
   */
  var error_callback = function(tr, error) {
    if (ydn.db.WebSqlWrapper.DEBUG) {
      window.console.log([tr, error]);
    }
    me.logger.warning('Error creating tables: ' + error.message);
  };

  var sqls = [];
  for (var i = 0; i < this.schema.stores.length; i++) {
    sqls.push(this.prepareCreateTable_(this.schema.stores[i]));
  }


  // TODO: deleting tables.

  this.doSqlTransaction(function (t) {

    me.logger.finest('Creating tables ' + sqls.join('\n'));
    for (var i = 0; i < sqls.length; i++) {
      if (ydn.db.WebSqlWrapper.DEBUG) {
        window.console.log(sqls[i]);
      }
      t.getTx().executeSql(sqls[i], [],
          i == sqls.length - 1 ? success_callback : undefined,
          error_callback);
    }
  }, [], ydn.db.TransactionMode.READ_WRITE);

};


/**
 * Parse resulting object of a row into original object as it 'put' into the
 * database.
 * @final
 * @protected
 * @param {ydn.db.StoreSchema} table table of concern.
 * @param {!Object} row row.
 * @return {!Object} parse value.
 */
ydn.db.WebSqlWrapper.prototype.parseRow = function(table, row) {
  goog.asserts.assertObject(row);
  var value = ydn.json.parse(row[ydn.db.DEFAULT_BLOB_COLUMN]);
  var key = row[table.keyPath]; // NOT: table.getKey(row);
  table.setKey(value, key);
  for (var j = 0; j < table.indexes.length; j++) {
    var index = table.indexes[j];
    if (index.name == ydn.db.DEFAULT_BLOB_COLUMN) {
      continue;
    }
    var x = row[index.name];
    if (!goog.isDef(x)) {
      continue;
    }
    if (index.type == ydn.db.DataType.INTEGER) {
      x = parseInt(x, 10);
    } else if (index.type == ydn.db.DataType.FLOAT) {
      x = parseFloat(x);
    }
    value[index.name] = x;
  }
  return value;
};


/**
 * Extract key from row result.
 * @final
 * @protected
 * @param {ydn.db.StoreSchema} table table of concern.
 * @param {!Object} row row.
 * @return {!Object} parse value.
 */
ydn.db.WebSqlWrapper.prototype.getKeyFromRow = function(table, row) {
  return row[table.keyPath || ydn.db.DEFAULT_KEY_COLUMN];
};


/**
 * @final
 */
ydn.db.WebSqlWrapper.prototype.close = function () {
  // WebSQl API do not have close method.
  return goog.async.Deferred.succeed(true);
};


/**
 * Flag use inside transaction method to make, subsequent call are
 * available for using existing transaction.
 * @type {boolean}
 * @private
 */
ydn.db.WebSqlWrapper.prototype.is_open_transaction_ = false;


/**
 * @final
 * @protected
 * @return {boolean} true indicate active transaction to be use.
 */
ydn.db.WebSqlWrapper.prototype.isOpenTransaction = function() {
  return this.sql_mu_tx_.isActiveAndAvailable() && this.is_open_transaction_;
};



/**
 * Run a transaction. If already in transaction, this will join the transaction.
 * @param {function(ydn.db.SqlTxMutex)} trFn
 * @param {Array.<string>} scopes
 * @param {ydn.db.TransactionMode} mode
 * @protected
 * @final
 */
ydn.db.WebSqlWrapper.prototype.doSqlTransaction = function(trFn, scopes, mode) {

  var me = this;
  if (!this.sql_mu_tx_.isActiveAndAvailable()) {
    /**
     * SQLTransactionCallback
     * @param {!SQLTransaction} tx
     */
    var transaction_callback = function(tx) {
      me.sql_mu_tx_.up(tx);
      trFn(me.sql_mu_tx_);
    };

    /**
     * SQLVoidCallback
     */
    var success_callback = function() {
      me.sql_mu_tx_.down(ydn.db.TransactionEventTypes.COMPLETE, true);
      me.runTxQueue_();
    };

    /**
     * SQLTransactionErrorCallback
     * @param {SQLError} e
     */
    var error_callback = function(e) {
      me.sql_mu_tx_.down(ydn.db.TransactionEventTypes.ERROR, e);
      me.runTxQueue_();
    };

    if (mode == ydn.db.TransactionMode.READ_ONLY) {
      this.sql_db_.readTransaction(transaction_callback,
          error_callback, success_callback);
    } else {
      this.sql_db_.transaction(transaction_callback,
          error_callback, success_callback);
    }

  } else {
    this.sql_tx_queue.push({fnc: trFn, scopes: scopes, mode: mode});
  }

};




/**
 * Perform explicit isolated transaction.
 * @param {Function} trFn function that invoke in the transaction.
 * @param {!Array.<string>} scopes list of store names involved in the
 * transaction.
 * @param {ydn.db.TransactionMode} mode mode, default to 'readonly'.
 * @final
 */
ydn.db.WebSqlWrapper.prototype.transaction = function (trFn, scopes, mode) {

  var me = this;

  if (this.sql_mu_tx_.isActive()) {
    // honour explicit transaction request, by putting it in the queue

    // wrap TrFn so that we can toggle it is_open_transaction_.
    var wrapTrFn = goog.partial(function(trFn, tx) {
      me.is_open_transaction_ = true;
      // now execute transaction process
      trFn(tx.getTx());
      me.is_open_transaction_ = false;
    }, trFn);

    this.sql_tx_queue.push({fnc:wrapTrFn, scopes:scopes, mode:mode});
  } else {

   this.doSqlTransaction(function(tx) {
     if (ydn.db.WebSqlWrapper.DEBUG) {
       window.console.log([tx, trFn, scopes, mode]);
     }
     // by opening transaction, all get/put methods will use current
     // transaction
     me.is_open_transaction_ = true;
     // now execute transaction process
     trFn(tx.getTx());

     me.is_open_transaction_ = false;

   }, scopes, mode);

  }

};