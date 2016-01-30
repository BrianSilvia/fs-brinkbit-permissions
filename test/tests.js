'use strict';

/* eslint-env mocha */
/* eslint new-cap: 0 */
/* eslint no-unused-expressions: 0 */
// todo: remove this after finishing tests
/* eslint no-unused-vars: 0 */
/* eslint no-shadow: 0 */

const chai = require( 'chai' );
const expect = chai.expect;
const chaiaspromised = require( 'chai-as-promised' );
const sinonchai = require( 'sinon-chai' );
const mime = require( 'mime' );
const mongoose = require( 'mongoose' );
const Permissions = require( '../src/schemas/permissionSchema.js' );
const s3Mongo = require( 'fs-s3-mongo' );
const File = s3Mongo.schema.file;
const Meta = s3Mongo.schema.meta;
const fsPermissions = require( '../src/index.js' );
const verify = fsPermissions.verify;

chai.use( sinonchai );
chai.use( chaiaspromised );

// HARDCODED FIXTURE VERSION
// create the path
const path = [ 'level1', 'level2', 'level3', 'test.txt' ];
// stub the userid
let userId = new mongoose.Types.ObjectId();

// create the meta and permissions
const insertFixture = function insertFixture( pathVar, userIdVar ) {
    // for each level:
    const promises = pathVar.map(( value, index, array ) => {
        // create the meta
        let meta = new Meta({
            guid: 'TESTDATA', // s3 guid
            get mimeType() {
                let mimeVar;
                if ( index === array.length ) {
                    mimeVar = mime.lookup( value.split( '.' ).pop());
                }
                else {
                    mimeVar = 'folder';
                }
                return mimeVar;
            },
            size: 12345678,
            dateCreated: new Date(), // https://docs.mongodb.org/v3.0/reference/method/Date/
            lastModified: new Date(), // https://docs.mongodb.org/v3.0/reference/method/Date/
            get children() {
                if ( index !== array.length ) {
                    return array[index + 1];
                }
            },
        });
        return meta.save()
            .then(( metaObj ) => {
                // overwrite meta with more meta
                meta = metaObj;
                // create the permission record
                const permissions = new Permissions({
                    get resourceType() {
                        let resourceType;
                        if ( meta.mimeType === 'folder' ) {
                            resourceType = 'folder';
                        }
                        else {
                            resourceType = 'file';
                        }
                        return resourceType;
                    },  // project or file/folder and we can easily add additional resource types later
                    resourceId: meta.id, // links to metadata id or project id
                    appliesTo: 'user', // 'user', 'group', 'public'
                    userId: userIdVar,
                    groupId: null, // if applies to group
                    read: true,
                    write: true,
                    destroy: true,
                    // share: [String], add additional user with default permissions for collaboration
                    manage: true, // update/remove existing permissions on resource
                });
                return permissions.save();
            })
            .then(() => {
                // create the file record
                const file = new File({
                    metaDataId: meta.id, // link to METADATA
                    userId: userIdVar, // link to User Collection
                    get name() {
                        let name;
                        if ( array.length === index + 1 ) {
                            name = array.join( '/' );
                        }
                        else {
                            name = array.slice( 0, index + 1 ).join( '/' ) + '/';
                        }
                        return name;
                    },
                    get parent() {
                        let parent;
                        parent = array.slice( 0, index ).join( '/' );
                        if ( parent ) parent += '/';
                        return parent;
                    },
                });
                return file.save();
            })
            .catch(( e ) => {
                return Promise.reject( e );
            });
    });
    return Promise.all( promises );
};


describe( 'verify', ( ) => {
    beforeEach( function beforeEach( done ) {
        return insertFixture( path, userId )
        .then(() => {
            done();
        })
        .catch(( e ) => {
            throw ( e );
        });
    });

    afterEach( function afterEach( done ) {
        // make an array of all test meta ids
        let ids;
        Meta.find({ guid: 'TESTDATA' }).exec()
        .then(( docs ) => {
            ids = docs.map( function mapId( item ) {
                return item._id;
            });
            // now remove all the things
            Meta.remove({ _id: { $in: ids } })
            .then(() => {
                Permissions.remove({ resourceId: { $in: ids } });
            })
            .then(() => {
                File.remove({ metaDataId: { $in: ids } });
            })
            .then( done());
        })
        .catch(( e ) => {
            throw ( e );
        });
    });
    // userId, path, operation
    userId = userId.toString();
    const rejectUser = new mongoose.Types.ObjectId().toString();
    it( 'should allow reading a file with correct permissions', () => {
        // return expect(Promise.resolve({ foo: "bar" })).to.be.fulfilled;
        return expect( verify( userId, 'read', 'level1/level2/level3/test.txt' )).to.be.fulfilled;
    });
    it( 'should reject reading a file with incorrect permissions', () => {
        expect( verify( rejectUser, 'level1/level2/level3/test.txt', 'read' ))
            .to.be.rejectedWith( 'user does not have read permissions on this object' );
    });
    it( 'should allow updating a file with correct permissions', () => {
        expect( verify( userId, 'level1/level2/level3/test.txt', 'update' )).to.be.fulfilled;
    });
    it( 'should reject updating a file with incorrect permissions', () => {
        expect( verify( rejectUser, 'level1/level2/level3/test.txt', 'update' ))
            .to.be.rejectedWith( 'user does not have write permissions on this object' );
    });
    it( 'should allow destroying a file with correct permissions', () => {
        expect( verify( userId, '/level1/level2/level3/test.txt', 'destroy' )).to.be.fulfilled;
    });
    it( 'should reject destroying a file with incorrect permissions', () => {
        expect( verify( rejectUser, 'level1/level2/level3/test.txt', 'destroy' ))
            .to.be.rejectedWith( 'user does not have write permissions on this object' );
    });
    it( 'should allow insertion of a file with correct permissions on the parent folder', () => {
        expect( verify( userId, 'level1/level2/permissions1.txt', 'write' )).to.be.fulfilled;
    });
    it( 'should reject insertion of a file with incorrect permissions on the parent folder', () => {
        expect( verify( rejectUser, 'level1/level2/permissions2.txt', 'write' ))
            .to.be.rejectedWith( 'user does not have write permissions on this object' );
    });
    // should not treat a file as a folder
    it( 'not allow insertion of a file into another file', () => {
        expect( verify( userId, 'level1/level2/level3/test.txt/nestedTest.txt', 'write' ))
            .to.be.rejectedWith( 'tried to add object to file' );
    });
    // should not create a duplicate file
    it( 'not allow insertion of a duplicate file', () => {
        expect( verify( userId, 'level1/level2/level3/test.txt', 'write' ))
            .to.be.rejectedWith( 'object already exists at that path' );
    });
});
