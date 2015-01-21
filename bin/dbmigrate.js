var async = require('async')
  , fs = require('fs')
  , sqlite3 = require('sqlite3');

var target_db_path = process.argv[2];
if (! target_db_path) {
  console.log("USAGE: bin/dbmigrate.js DATABASE_FILE_PATH");
  process.exit(0);
}
var migrate_db_path = target_db_path + ".migrate";

/*
var SQLITE_TABLE_DEFINITIONS_v0 = [
  'CREATE TABLE IF NOT EXISTS queries (id VARCHAR(32) NOT NULL PRIMARY KEY, json TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS results (id VARCHAR(32) NOT NULL PRIMARY KEY, json TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, yyyymm VARCHAR(6) NOT NULL, queryid VARCHAR(32) NOT NULL)',
  'CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, queryid VARCHAR(32) NOT NULL, tag VARCHAR(16) NOT NULL)'
];
*/

var SQLITE_TABLE_DEFINITIONS_v1 = [
  'CREATE TABLE IF NOT EXISTS queries (autoid INTEGER PRIMARY KEY AUTOINCREMENT, id VARCHAR(32) NOT NULL UNIQUE, datetime TEXT NOT NULL, expression TEXT NOT NULL, result TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, queryid VARCHAR(32) NOT NULL, tag VARCHAR(16) NOT NULL)'
];

var on_connect = function(cb){
  async.series(SQLITE_TABLE_DEFINITIONS_v1.map(function(sql){
	return function(callback) {
      migrate.run(sql, function(error){
        if (error) { callback(error.message); return; }
        callback(null);
      });
	};
  }), function(err,results){
	if (err)
      throw "failed to initialize new db file: " + migrate_db_path;
    cb();
  });
};

var original;
var migrate;

var open_original = function(cb){
  original = new sqlite3.Database(target_db_path, sqlite3.OPEN_READONLY, function(){
    cb(null);
  });
};

var open_migrate = function(cb){
  migrate = new sqlite3.Database(migrate_db_path, (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE), function(){
    on_connect(function(){ cb(null); });
  });
};

var migrate_tags = function(cb){
  original.all('SELECT queryid, tag FROM tags ORDER BY id', function(err, rows){
    if (err) {
      cb(err);
      return;
    }
    async.series(rows.map(function(row){
      return function(cb){
        migrate.run('INSERT INTO tags (queryid, tag) VALUES (?,?)', [row.queryid, row.tag], function(err){
          cb(err);
        });
      };
    }), function(err, results){
      cb(err);
    });
  });
};

var results = {}; // resultid -> obj

var store_results = function(cb){
  'CREATE TABLE IF NOT EXISTS results (id VARCHAR(32) NOT NULL PRIMARY KEY, json TEXT NOT NULL)',
  original.all('SELECT id, json FROM results', function(err, rows){
    if (err) {
      cb(err);
      return;
    }
    rows.forEach(function(row){
      results[row.id] = row.json;
    });
    cb(null);
  });
};

var migrate_queries = function(cb){
  original.all('SELECT id, json FROM queries', function(err, rows_original){
    if (err) {
      cb(err);
      return;
    }
    var rows = rows_original.filter(function(row){
      var json = row.json;
      if (json) {
        var r = JSON.parse(json).results.concat().pop();
        if (r && results[r.resultid])
          return true;
      }
      return false;
    }).map(function(row){
      var obj = JSON.parse(row.json);
      var result = obj.results.pop();
      return {
        id: row.id,
        expression: obj.querystring,
        result_json: results[result.resultid],
        date: new Date(result.executed_at).toJSON()
      };
    });
    rows.sort(function(a, b){ return a.date - b.date; });
    async.series(rows.map(function(obj){
      return function(cb) {
        migrate.run(
            'INSERT INTO queries (id,datetime,expression,result) VALUES (?,?,?,?)',
            [obj.id, obj.date, obj.expression, obj.result_json],
            function(err){ cb(err); }
        );
      };
    }), function(err, results){ cb(err); });
  });
};

async.series([
  open_original,
  open_migrate,
  migrate_tags,
  store_results,
  migrate_queries
], function(err, results){
  if (err) {
    console.log(err);
    throw "failed to migrate database...";
  }
});
